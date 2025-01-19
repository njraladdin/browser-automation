const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Custom CSS escape function since we're in Node.js environment
function cssEscape(value) {
  return value
    .replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&') // Escape special characters
    .replace(/^-/, '\\-')           // Escape leading hyphen
    .replace(/^\d/, '\\3$& ');      // Escape leading digit
}

class PageSnapshot {
  constructor(page) {
    this.page = page; // Store the puppeteer page instance
    this.$ = null;
    this.selectorCounter = 0;
    this.selectorToOriginalMap = new Map();
    this.snapshot = {
      url: null,
      html: null,
      interactive: null,
      content: null,
      timestamp: null
    };
    this.observer = null;
    this.processedElements = new Set();

    this.latestDOMChangesForInteractiveElements = [];
    this.latestDOMChangesForContentElements = [];
  }

  async captureSnapshot() {
    const snapshotStartTime = Date.now();
    try {
      // Then ensure DOM is ready (important for SPAs and dynamic content)
      await this.page.waitForFunction(
        () => document.readyState === 'complete',
        { timeout: 10000 }
      ).catch(e => {
        console.log('DOM load timeout reached:', e.message);
      });

      console.log('Page fully loaded');
      // Capture current URL
      this.snapshot.url = await this.page.url();

      // Capture both regular HTML and shadow DOM content
      const { html, shadowDOMData, iframeData } = await this.page.evaluate(() => {
        function captureShadowDOM(root) {
          const shadowTrees = [];

          const hosts = root.querySelectorAll('*');
          hosts.forEach(host => {
            if (host.shadowRoot) {
              // Capture the shadow root's content and structure
              shadowTrees.push({
                hostElement: {
                  tagName: host.tagName.toLowerCase(),
                  id: host.id,
                  classList: Array.from(host.classList)
                },
                content: host.shadowRoot.innerHTML,
                // Recursively capture nested shadow DOMs
                shadowTrees: captureShadowDOM(host.shadowRoot)
              });
            }
          });

          return shadowTrees;
        }

        // Add iframe content capture
        function captureIframes() {
          const iframes = [];
          document.querySelectorAll('iframe').forEach(iframe => {
            try {
              if (iframe.contentDocument) {
                iframes.push({
                  src: iframe.src,
                  content: iframe.contentDocument.body.innerHTML
                });
              }
            } catch (e) {
              // Skip iframes we can't access due to same-origin policy
              console.log('Could not access iframe content:', e);
            }
          });
          return iframes;
        }

        return {
          html: document.documentElement.outerHTML,
          shadowDOMData: captureShadowDOM(document),
          iframeData: captureIframes()
        };
      });

      // Store the complete shadow DOM data
      this.snapshot.shadowDOM = shadowDOMData;

      // Store the iframe data
      this.snapshot.iframeData = iframeData;

      // Load the HTML into cheerio
      this.$ = cheerio.load(html, {
        xml: {
          withDomLvl1: true,
          xmlMode: false,
        },
        isDocument: false
      });

      // Clean the page
      const cleanStartTime = Date.now();

      this.snapshot.html = this.$.root().html()
      console.log(`Page cleaning took ${Date.now() - cleanStartTime}ms`);

      // Replace separate map generations with single combined call
      const mapsStartTime = Date.now();
      const maps = await this.generatePageMaps();
      this.snapshot.interactive = maps.interactive;
      this.snapshot.content = maps.content;
      console.log(`Page maps generation took ${Date.now() - mapsStartTime}ms`);

      // Set timestamp
      this.snapshot.timestamp = new Date().toISOString();

      // Save debug files
      await this.saveDebugFiles();

      // Start observing DOM changes AFTER capturing the snapshot
      console.log('Starting DOM observer to track post-snapshot changes...');
      await this.startDOMObserver();

      console.log(`Total snapshot capture took ${Date.now() - snapshotStartTime}ms`);
      return this.snapshot;
    } catch (error) {
      console.error('Failed to capture snapshot:', error);
      throw error;
    }
  }

  sanitizeSelector(selector) {
    if (!selector) return selector;

    // Handle ID selectors specially
    if (selector.startsWith('#')) {
      // For IDs, we need to escape special characters according to CSS rules
      const id = selector.slice(1); // Remove the # symbol
      return '#' + cssEscape(id);
    }

    // For other selectors, replace problematic characters
    return selector
      .replace(/[^\w-]/g, '\\$&') // Escape special characters with backslash
      .replace(/^(\d)/, '_$1')    // Prefix with underscore if starts with number
      .replace(/\\/g, '\\\\')     // Escape backslashes
      .replace(/'/g, "\\'")       // Escape single quotes
      .replace(/"/g, '\\"')       // Escape double quotes
      .replace(/\//g, '\\/')      // Escape forward slashes
      .replace(/:/g, '\\:')       // Escape colons
      .replace(/\./g, '\\.')      // Escape dots
      .replace(/\s+/g, ' ');      // Normalize whitespace
  }

  generateSelector($el) {
    // Start timing
    const startTime = performance.now();

    try {
      // 1. First try test IDs (highest priority)
      const testId = $el.attr('data-testid') || $el.attr('data-test-id') || $el.attr('data-qa');
      if (testId) {
        return `[data-testid="${testId}"]`;
      }

      // 2. Try href for anchor tags
      if ($el.prop('tagName').toLowerCase() === 'a') {
        const href = $el.attr('href');
        if (href && !href.includes('{{') && !href.includes('${')) {
          // Ensure href is not a template literal or dynamic
          return `a[href="${href}"]`;
        }
      }

      // 3. Try aria-label
      const ariaLabel = $el.attr('aria-label');
      if (ariaLabel) {
        return `[aria-label="${ariaLabel}"]`;
      }

      // 4. Try name attribute
      const name = $el.attr('name');
      if (name) {
        return `[name="${name}"]`;
      }

      // 5. Try ID
      const id = $el.attr('id');
      if (id) {
        const safeId = this.sanitizeSelector(id);
        if (safeId && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(safeId)) {
          return `#${safeId}`;
        }
      }

      // 6. Build a path, but more efficiently
      const path = [];
      let current = $el;
      let maxAncestors = 4; // Limit path length

      while (current.length && maxAncestors > 0) {
        let selector = current.prop('tagName').toLowerCase();

        // Check for test IDs at each level
        const currentTestId = current.attr('data-testid') ||
          current.attr('data-test-id') ||
          current.attr('data-qa');
        if (currentTestId) {
          path.unshift(`[data-testid="${currentTestId}"]`);
          break;
        }

        // Check for href at each level for anchor tags
        if (selector === 'a') {
          const href = current.attr('href');
          if (href && !href.includes('{{') && !href.includes('${')) {
            path.unshift(`a[href="${href}"]`);
            break;
          }
        }

        // Check for aria-label at each level
        const currentAriaLabel = current.attr('aria-label');
        if (currentAriaLabel) {
          path.unshift(`[aria-label="${currentAriaLabel}"]`);
          break;
        }

        // Check for name at each level
        const currentName = current.attr('name');
        if (currentName) {
          path.unshift(`[name="${currentName}"]`);
          break;
        }

        // Add id if present
        const currentId = current.attr('id');
        if (currentId) {
          const safeId = this.sanitizeSelector(currentId);
          if (safeId && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(safeId)) {
            path.unshift(`#${safeId}`);
            break;
          }
        }

        // Add classes (but be selective)
        const classes = current.attr('class');
        if (classes) {
          const goodClasses = classes.split(/\s+/)
            .filter(cls =>
              cls &&
              cls.length > 3 &&
              // Avoid dynamic/utility classes
              !cls.match(/^(hover|focus|active|text-|bg-|p-|m-|flex|grid|w-|h-|border)/) &&
              !/[[\]()\\\/:]/.test(cls) &&
              !cls.includes('_') &&
              !cls.match(/\d/) // Avoid classes with numbers (often dynamic)
            )
            .slice(0, 3); // Take up to 3 most specific classes

          if (goodClasses.length > 0) {
            selector += '.' + goodClasses.join('.');
          }
        }

        // Add position only if needed
        const siblings = current.siblings(selector).addBack();
        if (siblings.length > 1) {
          const index = siblings.index(current) + 1;
          selector += `:nth-child(${index})`;
        }

        path.unshift(selector);
        current = current.parent();
        maxAncestors--;
      }

      return path.join(' > ');
    } catch (error) {
      console.warn('Selector generation failed, using fallback:', error);
      const tag = $el.prop('tagName').toLowerCase();
      const index = $el.parent().children().index($el) + 1;
      return `${tag}:nth-child(${index})`;
    } finally {
      const duration = performance.now() - startTime;
      if (duration > 5) {
        console.warn(`Slow selector generation: ${duration.toFixed(1)}ms for ${$el.prop('tagName')}`);
      }
    }
  }

  findAssociatedLabel($el) {
    const id = $el.attr('id');
    if (id) {
      const label = $el.closest('form, body').find(`label[for="${id}"]`).text().trim();
      if (label) return label;
    }
    return $el.closest('label').text().trim() || null;
  }

  async saveDebugFiles() {

    const testDir = path.join(__dirname, 'test');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }

    const timestamp = this.snapshot.timestamp.replace(/[:.]/g, '-');

    // Ensure we have resolved HTML content

    const interactiveContent = await Promise.resolve(this.snapshot.interactive);
    fs.writeFileSync(
      path.join(testDir, `interactive_${timestamp}.json`),
      JSON.stringify(interactiveContent, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(testDir, `content_${timestamp}.json`),
      JSON.stringify(this.snapshot.content, null, 2),
      'utf8'
    );

    console.log(`Debug files saved with timestamp: ${timestamp}`);

    return timestamp;
  }

  replaceSelectorsWithOriginals(text) {
    // Regular expression to match __SELECTOR__N pattern
    const selectorPattern = /__SELECTOR__\d+/g;

    return text.replace(selectorPattern, (match) => {
      const originalSelector = this.selectorToOriginalMap.get(match);
      return originalSelector || match; // Return original if found, otherwise keep unchanged
    });
  }

  getNearbyElementsText($el) {
    const nearbyElements = new Set();

    // Helper to process an element and its attributes
    const processElement = ($element) => {
      const texts = [];

      // Get element's text content
      const text = $element.text().trim();
      if (text) texts.push(text);

      // Get important attributes
      const placeholder = $element.attr('placeholder');
      const ariaLabel = $element.attr('aria-label');
      const type = $element.attr('type');
      const src = $element.attr('src');

      if (placeholder) texts.push(`placeholder: ${placeholder}`);
      if (ariaLabel) texts.push(`aria-label: ${ariaLabel}`);
      if (type) texts.push(`type: ${type}`);
      if (src) texts.push(`src: ${src}`);

      return texts.join(' | ');
    };

    // Get parent texts (2 levels up)
    let parent = $el.parent();
    for (let i = 0; i < 2 && parent.length; i++) {
      const text = processElement(parent.clone().children().remove().end());
      if (text) nearbyElements.add(`parent[${i + 1}]: ${text}`);
      parent = parent.parent();
    }

    // Get sibling texts (previous and next)
    const prevSibling = $el.prev();
    const nextSibling = $el.next();
    if (prevSibling.length) nearbyElements.add(`prev_sibling: ${processElement(prevSibling)}`);
    if (nextSibling.length) nearbyElements.add(`next_sibling: ${processElement(nextSibling)}`);

    // Get child texts (direct children and grandchildren)
    $el.children().slice(0, 2).each((index, child) => {
      const text = processElement(this.$(child));
      if (text) nearbyElements.add(`child[${index + 1}]: ${text}`);
    });

    // Get texts from elements with aria-label nearby
    $el.parent().find('[aria-label], [placeholder], [type], [src]').slice(0, 2).each((index, el) => {
      const text = processElement(this.$(el));
      if (text) nearbyElements.add(`nearby_element[${index + 1}]: ${text}`);
    });

    return Array.from(nearbyElements)
      .filter(text => text.length > 0)
      .slice(0, 5) // Limit to 5 most relevant nearby texts
      .join(' || ') // Join different elements with double pipes
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim(); // Remove leading/trailing whitespace
  }

  async startDOMObserver() {
    try {
      // Clear any existing interval first
      if (this.changeCollectionInterval) {
        clearInterval(this.changeCollectionInterval);
      }

      await this.page.evaluate(() => {
        window.__domChanges = [];

        // Helper function to get clean HTML content
        function getCleanHTML(element) {
          if (element.nodeType !== 1) return element.textContent;

          const container = document.createElement('div');
          container.appendChild(element.cloneNode(true));
          // Remove all style/script elements
          const styles = container.getElementsByTagName('style');
          const scripts = container.getElementsByTagName('script');
          [...styles, ...scripts].forEach(el => el.remove());
          // Remove all style/script elements and style attributes
          const elements = container.getElementsByTagName('*');
          for (let el of elements) {
            el.removeAttribute('style');
          }

          return container.innerHTML;
        }

        // Helper function to get element's selector path
        function getElementPath(element) {
          const path = [];
          let currentNode = element;

          while (currentNode && currentNode !== document.body) {
            let selector = currentNode.tagName.toLowerCase();

            if (currentNode.id) {
              selector = `#${currentNode.id}`;
              path.unshift(selector);
              break;
            } else {
              const classes = Array.from(currentNode.classList)
                .filter(cls => !cls.match(/^(hover|focus|active)/) && !cls.includes('(') && !cls.includes(')') && !cls.includes('[') && !cls.includes(']'));

              if (classes.length) {
                selector += '.' + classes.join('.');
              }

              const parent = currentNode.parentNode;
              if (parent) {
                const siblings = Array.from(parent.children);
                const index = siblings.indexOf(currentNode) + 1;
                if (siblings.length > 1) {
                  selector += `:nth-child(${index})`;
                }
              }

              path.unshift(selector);
              currentNode = currentNode.parentNode;
            }
          }

          return path.join(' > ');
        }

        // Create mutation observer
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.target.tagName === 'STYLE' ||
              mutation.target.tagName === 'SCRIPT' ||
              mutation.target.tagName === 'LINK' ||
              mutation.target.tagName === 'HEAD') {
              return;
            }

            if (mutation.type === 'childList') {
              const addedNode = mutation.addedNodes[0];
              if (addedNode) {
                const change = {
                  type: mutation.type,
                  timestamp: new Date().toISOString(),
                  target: {
                    tagName: mutation.target.tagName,
                    id: mutation.target.id,
                    className: mutation.target.className
                  },
                  selectorPath: getElementPath(mutation.target),
                  changes: {
                    added: {
                      type: addedNode.nodeType === 1 ? 'element' : 'text',
                      content: addedNode.nodeType === 1 ?
                        getCleanHTML(addedNode) :
                        addedNode.textContent
                    }

                  }
                };

                if (change.changes.added) {
                  window.__domChanges.push(change);
                }
              }
            }
          });
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: false,
          characterDataOldValue: false,
          attributes: false
        });

        window.__domObserver = observer;
      });

      // Set up periodic collection of changes
      this.changeCollectionInterval = setInterval(async () => {
        try {
          const changes = await this.page.evaluate(() => {
            const currentChanges = window.__domChanges;
            window.__domChanges = [];
            return currentChanges;
          }).catch(error => {
            if (error.message.includes('detached') || error.message.includes('disconnected')) {
              console.log('Browser disconnected, clearing DOM observer interval');
              clearInterval(this.changeCollectionInterval);
            }
            return [];  // Return empty array instead of null
          });

          if (changes && changes.length > 0) {
            for (const change of changes) {
              const addedNode = change.changes?.added;  // Add null check with ?
              if (addedNode && addedNode.type === 'element') {
                const html = addedNode.content;
                const baseSelector = change.selectorPath;

                if (!html) continue;

                const $ = cheerio.load(html, {
                  xml: {
                    withDomLvl1: true,
                    xmlMode: false,
                  },
                  isDocument: false
                });

                const { interactive, content } = await this._generateMapsFromCheerio($, null, null, baseSelector);

                // Add null checks and ensure arrays
                if (Array.isArray(interactive) && interactive.length > 0) {
                  this.latestDOMChangesForInteractiveElements.push(...interactive);
                }

                if (Array.isArray(content) && content.length > 0) {
                  this.latestDOMChangesForContentElements.push(...content);
                }
              }
            }

            // Log the accumulated changes
            console.log('Current accumulated changes:', {
              interactiveCount: this.latestDOMChangesForInteractiveElements.length,
              contentCount: this.latestDOMChangesForContentElements.length
            });

            // Save full accumulated changes periodically
            if (this.latestDOMChangesForInteractiveElements.length > 0 || 
                this.latestDOMChangesForContentElements.length > 0) {
              fs.writeFileSync(
                path.join(__dirname, 'test', `latest_interactive_changes_${Date.now()}.json`),
                JSON.stringify(this.latestDOMChangesForInteractiveElements, null, 2),
                'utf8'
              );
              fs.writeFileSync(
                path.join(__dirname, 'test', `latest_content_changes_${Date.now()}.json`),
                JSON.stringify(this.latestDOMChangesForContentElements, null, 2),
                'utf8'
              );
            }
          }
        } catch (error) {
          console.error('Error in DOM observer interval:', error);
        }
      }, 1000);

    } catch (error) {
      console.error('Failed to start DOM observer:', error);
    }
  }



  static condenseContentMap(content, includeSelectors = true) {
    if (!content) {
      return '';
    }

    return content
      .map(item => {
        let result = '';

        // Add tag (with fallback) and aria-label if present
        const tag = item.tag || item.type || 'element';
        result = `[${tag}${item['aria-label'] ? ` aria-label: ${item['aria-label']}` : ''}${includeSelectors && item.selector ? ` selector:"${item.selector}"` : ''}]`;

        // Add content or src
        if (item.content) {
          result += ` ${item.content}`;
          // Add href for links if present
          if (item.href) {
            result += ` (href: ${item.href})`;
          }
        } else if (item.mediaType === 'video') {
          // Special handling for video elements
          const srcs = [];
          if (item.src) srcs.push(`src: ${item.src}`);
          if (item.sources) {
            item.sources.forEach(source => {
              srcs.push(`source: ${source.src}${source.type ? ` (${source.type})` : ''}`);
            });
          }
          if (item.poster) srcs.push(`poster: ${item.poster}`);
          result += ` ${srcs.join(' | ')}`;
        } else if (item.src) {
          result += ` src: ${item.src}${item.alt ? ` alt: ${item.alt}` : ''}`;
        } else {
          return null;
        }

        return result;
      })
      .filter(Boolean)
      .join('\n');
  }

  async generatePageMaps() {
    const mapsStartTime = Date.now();
    const maps = await this._generateMapsFromCheerio(
      this.$,
      this.snapshot.shadowDOM,
      this.snapshot.iframeData
    );

    this.snapshot.interactive = maps.interactive;
    this.snapshot.content = maps.content;

    console.log(`Generated maps with:
      - ${maps.interactive.length} interactive items
      - ${maps.content.length} content items
      Time taken: ${Date.now() - mapsStartTime}ms`);

    return maps;
  }

  async _generateMapsFromCheerio($, shadowDOM = null, iframeData = null, baseSelector = '') {
    const interactive = [];
    const content = [];
    const isDOMChange = !!baseSelector;

    // Helper function to process selector
    const processSelector = (originalSelector) => {
      let finalSelector = originalSelector;
      if (baseSelector) {
        finalSelector = `${baseSelector} > ${originalSelector}`;
      }

      if (finalSelector.length <= 10) {
        return { selector: finalSelector, originalSelector: finalSelector };
      }
      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, finalSelector);
      return { selector: shortSelector, originalSelector: finalSelector };
    };

    // Helper function to clean HTML
    const cleanHtml = ($elem) => {
      const $clone = $elem.clone();
      // Remove style attributes from element and all its descendants
      $clone.find('*').removeAttr('style');
      $clone.removeAttr('style');
      return $clone.wrap('<div>').parent().html();
    };

    // Process elements
    const elements = $($.root()).find('*').get();
    for (const element of elements) {
      const $el = $(element);

      // Skip script and style elements early
      if (['script', 'style', 'noscript'].includes(element.tagName.toLowerCase())) {
        continue;
      }

      const elementSelector = this.generateSelector($el);
      const { selector, originalSelector } = processSelector(elementSelector);

      // Skip visibility check for DOM changes
      if (!isDOMChange) {
        const isVisible = await this.isElementVisible(elementSelector);
        if (!isVisible) {
          continue;
        }
      }

      // Process for interactive map
      if ($el.is('input, textarea, select, [type="search"], [contenteditable="true"], faceplate-search-input, *[role="searchbox"], *[role="textbox"]')) {
        const interactiveItem = {
          type: 'input',
          inputType: $el.attr('type') || element.tagName.toLowerCase(),
          selector: selector,
          originalSelector: originalSelector,
          placeholder: $el.attr('placeholder'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          value: $el.attr('value'),
          name: $el.attr('name'),
          label: this.findAssociatedLabel($el),
          html: cleanHtml($el)
        };

        if (element.tagName.toLowerCase() === 'select') {
          interactiveItem.options = $el.find('option').map((_, option) => {
            const $option = $(option);
            return {
              value: $option.attr('value'),
              text: $option.text().trim(),
              selected: $option.attr('selected') !== undefined
            };
          }).get();
        }

        interactive.push(interactiveItem);
      }

      if ($el.is('button, [role="button"]')) {
        const buttonItem = {
          type: 'button',
          text: $el.text().trim(),
          selector: selector,
          originalSelector: originalSelector,
          buttonType: $el.attr('type'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          disabled: $el.prop('disabled'),
          nearbyElementsText: this.getNearbyElementsText($el),
          html: cleanHtml($el)
        };

        interactive.push(buttonItem);
      }

      if ($el.is('a')) {
        const text = $el.text().trim();
        const ariaLabel = $el.attr('aria-label');

        if (text || ariaLabel) {
          const linkItem = {
            type: 'link',
            text: text,
            selector: selector,
            originalSelector: originalSelector,
            href: $el.attr('href'),
            id: $el.attr('id'),
            role: $el.attr('role'),
            'aria-label': ariaLabel,
            html: cleanHtml($el)
          };

          interactive.push(linkItem);
        }
      }

      const nearbyText = this.getNearbyElementsText($el);

      // Process for content map
      const directText = $el.clone().children().remove().end().text().trim();
      if (directText) {
        content.push({
          type: element.tagName.toLowerCase() === 'a' ? 'link' : 'text',
          content: directText,
          tag: element.tagName.toLowerCase(),
          selector: selector,
          originalSelector: originalSelector,
          nearbyText,
          html: cleanHtml($el),
          ...(element.tagName.toLowerCase() === 'a' && { href: $el.attr('href') })
        });
      }

      if (element.tagName.toLowerCase() === 'img') {
        const src = $el.attr('src');
        if (src) {
          content.push({
            type: 'media',
            mediaType: 'image',
            src: src,
            selector: selector,
            originalSelector: originalSelector,
            alt: $el.attr('alt'),
            nearbyText,
            html: cleanHtml($el)
          });
        }
      } else if (element.tagName.toLowerCase() === 'video') {
        // Check for source elements within video
        const sources = $el.find('source').map((_, sourceEl) => {
          return {
            src: $(sourceEl).attr('src'),
            type: $(sourceEl).attr('type')
          };
        }).get();

        const src = $el.attr('src');
        const poster = $el.attr('poster');

        // Use src if available, otherwise use poster
        if (src || poster) {
          content.push({
            type: 'media',
            mediaType: 'video',
            src: src || poster,
            selector: selector,
            originalSelector: originalSelector,
            sources: sources.length > 0 ? sources : undefined,
            nearbyText,
            html: cleanHtml($el)
          });
        }
      }
    }

    // Process shadow DOM
    if (shadowDOM) {
      shadowDOM.forEach((shadowTree) => {
        const $shadow = cheerio.load(shadowTree.content);
        const shadowMaps = this._generateMapsFromCheerio($shadow, null, null);

        // Process interactive elements - shadowMaps.interactive is an array, not an object
        if (shadowMaps.interactive && Array.isArray(shadowMaps.interactive)) {
          shadowMaps.interactive.forEach(item => {
            const { selector, ...rest } = item;

            if (shadowTree.shadowTrees?.some(tree =>
              tree.hostElement.tagName.toLowerCase() === item.tag?.toLowerCase()
            )) {
              return;
            }

            interactive.push({
              ...rest,
              hostSelector: shadowTree.hostElement.tagName,
              shadowPath: [this.cleanShadowSelector(item.selector)]
            });
          });
        }

        // Process nested shadow DOMs
        if (shadowTree.shadowTrees) {
          shadowTree.shadowTrees.forEach(nestedShadow => {
            const $nestedShadow = cheerio.load(nestedShadow.content);
            const nestedMaps = this._generateMapsFromCheerio($nestedShadow, null, null);

            if (nestedMaps.interactive && Array.isArray(nestedMaps.interactive)) {
              nestedMaps.interactive.forEach(item => {
                const { selector, ...rest } = item;
                interactive.push({
                  ...rest,
                  hostSelector: shadowTree.hostElement.tagName,
                  shadowPath: [
                    nestedShadow.hostElement.tagName,
                    this.cleanShadowSelector(item.selector)
                  ]
                });
              });
            }
          });
        }
      });
    }

    // Process iframes
    if (iframeData) {
      iframeData.forEach((iframe) => {
        const $iframe = cheerio.load(iframe.content);
        const iframeMaps = this._generateMapsFromCheerio($iframe, null, null, `iframe[src="${iframe.src}"]`);

        // iframeMaps.interactive is an array, not an object
        if (iframeMaps.interactive && Array.isArray(iframeMaps.interactive)) {
          interactive.push(...iframeMaps.interactive);
        }
        if (iframeMaps.content && Array.isArray(iframeMaps.content)) {
          content.push(...iframeMaps.content);
        }
      });
    }

    return { interactive, content };
  }

  cleanShadowSelector(selector) {
    // Remove html and body from shadow DOM selectors
    return selector
      .replace(/^html\s*>\s*/, '')  // Remove html > from start
      .replace(/^body\s*>\s*/, '')  // Remove body > from start
      .replace(/>\s*body\s*>/g, '>')  // Remove body > from middle
      .replace(/>\s*html\s*>/g, '>')  // Remove html > from middle
      .trim();
  }

  getElementKey(hostSelector, shadowPath, type, attributes) {
    return JSON.stringify({
      hostSelector,
      shadowPath: shadowPath.join('->'),
      type,
      // Include relevant attributes that identify unique elements
      placeholder: attributes.placeholder,
      name: attributes.name,
      id: attributes.id
    });
  }
  async getNewMapItems() {
    try {
      // Get new snapshot
      await this.captureSnapshot();
      const newContent = this.snapshot.content;
      const newInteractive = this.snapshot.interactive;

      // Create sets of HTML signatures from DOM changes
      const changedContentHtml = new Set(
        this.latestDOMChangesForContentElements.map(item => item.html)
      );
      const changedInteractiveHtml = new Set(
        this.latestDOMChangesForInteractiveElements.map(item => item.html)
      );

      // Log initial counts
      console.log('DOM Changes found:', {
        contentChangesCount: changedContentHtml.size,
        interactiveChangesCount: changedInteractiveHtml.size
      });

      // Filter new items by matching HTML signatures
      const newItems = {
        content: newContent.filter(item => {
          const isNew = changedContentHtml.has(item.html);

          return isNew;
        }),
        interactive: newInteractive.filter(item => {
          const isNew = changedInteractiveHtml.has(item.html);
          return isNew;
        })
      };

      // Log results
      console.log('Filtered results:', {
        newContentCount: newItems.content.length,
        newInteractiveCount: newItems.interactive.length
      });

      // Clear the changes arrays after using them
      this.latestDOMChangesForContentElements = [];
      this.latestDOMChangesForInteractiveElements = [];

      // Save debug files if we found new items
      if (newItems.content.length > 0 || newItems.interactive.length > 0) {
        await this.saveNewItemsDebugFiles(newItems);
      }

      return newItems;
    } catch (error) {
      console.error('Error in getNewMapItems:', error);
      return {
        content: [],
        interactive: []
      };
    }
  }

  async saveNewItemsDebugFiles(newItems) {
    const testDir = path.join(__dirname, 'test');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (newItems.content.length > 0) {
      const contentPath = path.join(testDir, `new_content_${timestamp}.json`);
      fs.writeFileSync(contentPath, JSON.stringify(newItems.content, null, 2), 'utf8');
      console.log(`Saved ${newItems.content.length} new content items to: ${contentPath}`);
    }

    if (newItems.interactive.length > 0) {
      const interactivePath = path.join(testDir, `new_interactive_${timestamp}.json`);
      fs.writeFileSync(interactivePath, JSON.stringify(newItems.interactive, null, 2), 'utf8');
      console.log(`Saved ${newItems.interactive.length} new interactive items to: ${interactivePath}`);
    }
  }

  cleanContentMapForPrompt({ contentMap, condensed = false, stringify = false, removeSelectors = false }) {
    if (!contentMap) return condensed ? '' : [];
    // Clean the map - optionally remove selectors
    const cleanedMap = contentMap.map(({ originalSelector, html, selector, ...rest }) => {
      return removeSelectors ? rest : { selector, ...rest };
    });

    const result = condensed ? PageSnapshot.condenseContentMap(cleanedMap, !removeSelectors) : cleanedMap;
    return stringify ? JSON.stringify(result, null, 2) : result;
  }

  cleanInteractiveMapForPrompt({ interactiveMap, stringify = false, removeSelectors = false }) {
    if (!interactiveMap) return [];
    const cleanedMap = interactiveMap.map(({ originalSelector, html, selector, ...rest }) => {
      return removeSelectors ? rest : { selector, ...rest };
    });
    return stringify ? JSON.stringify(cleanedMap, null, 2) : cleanedMap;
  }

  async isElementVisible(selector) {
    try {
      return await this.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (!element) return false;

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return !!(
          element.offsetWidth > 0 &&
          element.offsetHeight > 0
          // &&
          // style.display !== 'none' &&
          // style.visibility !== 'hidden' &&
          // style.opacity !== '0' 
        );
      }, selector);
    } catch (error) {
      console.warn(`Error checking visibility for selector ${selector}:`, error);
      return false;
    }
  }
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    let browser;
    try {
      const url = 'https://twitter.com/elonmusk';
      console.log(`Testing PageSnapshot with URL: ${url}`);

      console.log('Launching browser...');
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: {
          width: 1280,
          height: 800
        }
      });

      const page = await browser.newPage();
      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

      console.log('Taking page snapshot...');
      const snapshot = new PageSnapshot(page);
      const result = await snapshot.captureSnapshot();

      console.log('\nSnapshot captured successfully!');
      console.log('Files saved with timestamp:', result.timestamp);

      // Set up periodic content checking
      console.log('\nStarting periodic content check...');
      const checkInterval = setInterval(async () => {
        try {
          console.log('\nChecking for new content...');
          const newItems = await snapshot.getNewMapItems();
          console.log(`Found ${newItems.content.length} new content items`);
          console.log(`Found ${Object.values(newItems.interactive).flat().length} new interactive items`);
        } catch (error) {
          console.error('Error during content check:', error);
          clearInterval(checkInterval);
        }
      }, 10000); // Check every 10 seconds

      // Allow manual termination with Ctrl+C
      process.on('SIGINT', () => {
        console.log('\nStopping content check...');
        clearInterval(checkInterval);
        if (browser) {
          browser.close();
        }
        process.exit(0);
      });

    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
} 
