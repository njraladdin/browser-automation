const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class PageSnapshot {
  constructor() {
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
    this.latestDOMChanges = [];
    this.observer = null;
    this.processedElements = new Set();

    this.latestDOMChangesForInteractiveElements = [];
    this.latestDOMChangesForContentElements = [];
  }

  async captureSnapshot(page) {
    const snapshotStartTime = Date.now();
    try {
      // Reset latest changes at the start of a new capture
      this.latestDOMChanges = [];

      // Then ensure DOM is ready (important for SPAs and dynamic content)
      await page.waitForFunction(
        () => document.readyState === 'complete',
        { timeout: 10000 }
      ).catch(e => {
        console.log('DOM load timeout reached:', e.message);
      });

      console.log('Page fully loaded');
      // Capture current URL
      this.snapshot.url = await page.url();
      
      // Capture both regular HTML and shadow DOM content
      const { html, shadowDOMData, iframeData } = await page.evaluate(() => {
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
        decodeEntities: true,
        xmlMode: false
      });

      // Clean the page
      const cleanStartTime = Date.now();
      this.cleanPage();
      this.snapshot.html = this.getCleanedHtml();
      console.log(`Page cleaning took ${Date.now() - cleanStartTime}ms`);

      // Replace separate map generations with single combined call
      const mapsStartTime = Date.now();
      const maps = await this.generatePageMaps(page);
      this.snapshot.interactive = maps.interactive;
      this.snapshot.content = maps.content;
      console.log(`Page maps generation took ${Date.now() - mapsStartTime}ms`);
      
      // Set timestamp
      this.snapshot.timestamp = new Date().toISOString();

      // Save debug files
      await this.saveDebugFiles();

      // Start observing DOM changes AFTER capturing the snapshot
      console.log('Starting DOM observer to track post-snapshot changes...');
      await this.startDOMObserver(page);

      console.log(`Total snapshot capture took ${Date.now() - snapshotStartTime}ms`);
      return this.snapshot;
    } catch (error) {
      console.error('Failed to capture snapshot:', error);
      throw error;
    }
  }

  // Get methods for accessing snapshot data
  getUrl() { return this.snapshot.url; }
  getHtml() { return this.snapshot.html; }
  getInteractiveView() { return this.snapshot.interactive; }
  getTimestamp() { return this.snapshot.timestamp; }
  
  cleanPage() {
    // Remove unwanted elements
    this.$('script').remove();
    this.$('style').remove();
    this.$('link[rel="stylesheet"]').remove();
    this.$('meta').remove();
    this.$('svg').remove();
    
    // Define whitelist of allowed attributes
    const allowedAttributes = new Set([
      'class', 'href', 'src', 'id', 'type', 'value', 'title',
      'alt', 'name', 'placeholder', 'role', 'aria-label',
      'target', 'rel', 'for', 'action', 'method'
    ]);

    // Clean all elements
    this.$('*').each((i, el) => {
      if (el.attribs) {
        Object.keys(el.attribs).forEach(attr => {
          if (!allowedAttributes.has(attr.toLowerCase())) {
            this.$(el).removeAttr(attr);
          }
        });
      }
    });
  }

  getCleanedHtml() {
    return this.$.root().html()
      .replace(/^\s*[\r\n]/gm, '')
      .replace(/\s+$/gm, '')
      .replace(/\n\s*\n\s*\n/g, '\n\n');
  }

  sanitizeSelector(selector) {
    if (!selector) return selector;
    
    return selector
      .replace(/[^\w-]/g, '_') // Replace any non-word chars (except hyphens) with underscore
      .replace(/^(\d)/, '_$1') // Prefix with underscore if starts with number
      .replace(/\\/g, '\\\\') // Escape backslashes
      .replace(/'/g, "\\'")   // Escape single quotes
      .replace(/"/g, '\\"')   // Escape double quotes
      .replace(/\//g, '_')    // Replace forward slashes with underscore
      .replace(/:/g, '_')     // Replace colons with underscore
      .replace(/\./g, '_')    // Replace dots with underscore when not part of a class selector
      .replace(/\s+/g, '_');  // Replace whitespace with underscore
  }

  generateSelector($el) {
    // Start timing
    const startTime = performance.now();
    
    try {
      // 1. First try ID - fastest path
      const id = $el.attr('id');
      if (id) {
        const safeId = this.sanitizeSelector(id);
        if (safeId && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(safeId)) {
          return `#${safeId}`;
        }
      }

      // 2. Try data-testid or similar attributes
      const testId = $el.attr('data-testid') || $el.attr('data-test-id') || $el.attr('data-qa');
      if (testId) {
        return `[data-testid="${testId}"]`;
      }

      // 3. Build a path, but more efficiently
      const path = [];
      let current = $el;
      let maxAncestors = 4; // Limit path length
      
      while (current.length && maxAncestors > 0) {
        let selector = current.prop('tagName').toLowerCase();
        
        // Add id if present
        const currentId = current.attr('id');
        if (currentId) {
          const safeId = this.sanitizeSelector(currentId);
          if (safeId && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(safeId)) {
            path.unshift(`#${safeId}`);
            break; // ID found, we can stop here
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

      // If path is empty (shouldn't happen), fallback to basic selector
      if (path.length === 0) {
        const tag = $el.prop('tagName').toLowerCase();
        const index = $el.parent().children().index($el) + 1;
        return `${tag}:nth-child(${index})`;
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
    const startTime = Date.now();
    
    const testDir = path.join(__dirname, 'test');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }

    const timestamp = this.snapshot.timestamp.replace(/[:.]/g, '-');
    
    // Ensure we have resolved HTML content
    const htmlContent = await Promise.resolve(this.snapshot.html);
    const interactiveContent = await Promise.resolve(this.snapshot.interactive);

    // Create a copy of interactive content with both selectors
    const interactiveWithSelectors = interactiveContent.map(item => ({
      ...item,
      originalSelector: this.selectorToOriginalMap.get(item.selector)
    }));
    
    fs.writeFileSync(
      path.join(testDir, `page_${timestamp}.html`),
      htmlContent,
      'utf8'
    );

    fs.writeFileSync(
      path.join(testDir, `interactive_${timestamp}.json`),
      JSON.stringify(interactiveWithSelectors, null, 2),
      'utf8'
    );

    // Create a copy of content map with both selectors
    const contentWithSelectors = this.snapshot.content.map(item => ({
      ...item,
      originalSelector: this.selectorToOriginalMap.get(item.selector) || item.selector
    }));

    fs.writeFileSync(
      path.join(testDir, `content_${timestamp}.json`),
      JSON.stringify(contentWithSelectors, null, 2),
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
    for(let i = 0; i < 2 && parent.length; i++) {
      const text = processElement(parent.clone().children().remove().end());
      if(text) nearbyElements.add(`parent[${i+1}]: ${text}`);
      parent = parent.parent();
    }

    // Get sibling texts (previous and next)
    const prevSibling = $el.prev();
    const nextSibling = $el.next();
    if(prevSibling.length) nearbyElements.add(`prev_sibling: ${processElement(prevSibling)}`);
    if(nextSibling.length) nearbyElements.add(`next_sibling: ${processElement(nextSibling)}`);

    // Get child texts (direct children and grandchildren)
    $el.children().slice(0, 2).each((index, child) => {
      const text = processElement(this.$(child));
      if(text) nearbyElements.add(`child[${index+1}]: ${text}`);
    });

    // Get texts from elements with aria-label nearby
    $el.parent().find('[aria-label], [placeholder], [type], [src]').slice(0, 2).each((index, el) => {
      const text = processElement(this.$(el));
      if(text) nearbyElements.add(`nearby_element[${index+1}]: ${text}`);
    });

    return Array.from(nearbyElements)
      .filter(text => text.length > 0)
      .slice(0, 5) // Limit to 5 most relevant nearby texts
      .join(' || ') // Join different elements with double pipes
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim(); // Remove leading/trailing whitespace
  }

  async startDOMObserver(page) {
    try {
      // Clear any existing interval first
      if (this.changeCollectionInterval) {
        clearInterval(this.changeCollectionInterval);
      }

      await page.evaluate(() => {
        window.__domChanges = [];
        
        // Helper function to get clean HTML content
        function getCleanHTML(element) {
          // Skip if not an element
          if (element.nodeType !== 1) return element.textContent;
          
          // Create a temporary container
          const container = document.createElement('div');
          container.appendChild(element.cloneNode(true));
          
          // Remove all style/script elements
          const styles = container.getElementsByTagName('style');
          const scripts = container.getElementsByTagName('script');
          [...styles, ...scripts].forEach(el => el.remove());
          
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
                mutation.target.tagName === 'LINK') {
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
                    added: addedNode ? {
                      type: addedNode.nodeType === 1 ? 'element' : 'text',
                      content: addedNode.nodeType === 1 ? 
                        getCleanHTML(addedNode) : // Clean HTML before storing
                        addedNode.textContent
                    } : null,
                    removed: mutation.removedNodes.length > 0 ? {
                      type: mutation.removedNodes[0].nodeType === 1 ? 'element' : 'text',
                      tagName: mutation.removedNodes[0].nodeType === 1 ? 
                        mutation.removedNodes[0].tagName : null,
                      textContent: mutation.removedNodes[0].nodeType === 3 ? 
                        mutation.removedNodes[0].textContent : null
                    } : null
                  }
                };

                if (change.changes.added || change.changes.removed) {
                  window.__domChanges.push(change);
                }
              }
            }
          });
        });

        observer.observe(document.body, {
          childList: true,
          characterData: false,
          subtree: true,
          characterDataOldValue: false,
          attributes: false
        });

        window.__domObserver = observer;
      });

      // Set up periodic collection of changes
      this.changeCollectionInterval = setInterval(async () => {
        try {
          const changes = await page.evaluate(() => {
            const currentChanges = window.__domChanges;
            window.__domChanges = []; 
            return currentChanges;
          }).catch(error => {
            // If browser is disconnected, clear the interval
            if (error.message.includes('detached') || error.message.includes('disconnected')) {
              console.log('Browser disconnected, clearing DOM observer interval');
              clearInterval(this.changeCollectionInterval);
            }
            return null;
          });

          if (changes && changes.length > 0) {
            changes.forEach(change => {
              if (change.type === 'childList') {
                const addedNode = change.changes.added;
                if (addedNode && addedNode.type === 'element') {
                  const html = addedNode.content;
                  const baseSelector = change.selectorPath;

                  if (!html) return;

                  const $ = cheerio.load(html, {
                    xml: {
                      withDomLvl1: true,
                      xmlMode: false,
                    },
                    isDocument: false
                  });

                  const { interactive, content } = this._generateMapsFromCheerio($, null, null, baseSelector);

                  // Debug log before adding items
                  console.log('Processing DOM change:', {
                    baseSelector,
                    foundInteractive: interactive.length,
                    foundContent: content.length
                  });

                  if (content.length > 0 || interactive.length > 0) {
                    if (interactive.length > 0) {
                      this.latestDOMChangesForInteractiveElements.push(...interactive);
                      // Debug log interactive items
                      // fs.writeFileSync(
                      //   path.join(__dirname, 'test', `debug_interactive_changes_${Date.now()}.json`),
                      //   JSON.stringify(interactive, null, 2),
                      //   'utf8'
                      // );
                    }

                    if (content.length > 0) {
                      this.latestDOMChangesForContentElements.push(...content);
                      // Debug log content items
                      // fs.writeFileSync(
                      //   path.join(__dirname, 'test', `debug_content_changes_${Date.now()}.json`),
                      //   JSON.stringify(content, null, 2),
                      //   'utf8'
                      // );
                    }
                  }
                }
              }
            });

            // Log the accumulated changes
            console.log('Current accumulated changes:', {
              interactiveCount: this.latestDOMChangesForInteractiveElements.length,
              contentCount: this.latestDOMChangesForContentElements.length
            });

            // Save full accumulated changes periodically
            fs.writeFileSync(
              path.join(__dirname, 'test', `accumulated_changes_${Date.now()}.json`),
              JSON.stringify({
                interactive: this.latestDOMChangesForInteractiveElements,
                content: this.latestDOMChangesForContentElements
              }, null, 2),
              'utf8'
            );
          }
        } catch (error) {
          console.error('Error in DOM observer interval:', error);
        }
      }, 1000);

    } catch (error) {
      console.error('Failed to start DOM observer:', error);
    }
  }

  async stopDOMObserver(page) {
    try {
      clearInterval(this.changeCollectionInterval);
      
      await page.evaluate(() => {
        if (window.__domObserver) {
          window.__domObserver.disconnect();
          delete window.__domObserver;
        }
      });

      console.log('DOM observer stopped');
    } catch (error) {
      console.error('Failed to stop DOM observer:', error);
    }
  }

  async logChangesToFile(changes) {
    try {
      const testDir = path.join(__dirname, 'test');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(testDir, `dom_changes_${timestamp}.json`);

      console.log(`Writing to ${logPath}`);
      fs.writeFileSync(
        logPath,
        JSON.stringify(changes, null, 2),
        'utf8'
      );
      console.log('File written successfully');
    } catch (error) {
      console.error('Failed to log DOM changes:', error);
      console.error(error.stack);
    }
  }

  getLatestDOMChanges() {
    return this.latestDOMChanges;
  }


  // Change from instance method to static method that accepts content
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

  async generatePageMaps(page) {
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

  _generateMapsFromCheerio($, shadowDOM = null, iframeData = null, baseSelector = '') {
    const interactive = [];
    const content = [];

    // Helper function to process selector
    const processSelector = (originalSelector) => {
      let finalSelector = originalSelector;
      if (baseSelector) {
        finalSelector = `${baseSelector} > ${originalSelector}`;
      }

      if (finalSelector.length <= 300) {
        return finalSelector;
      }
      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, finalSelector);
      return shortSelector;
    };

    // Process elements
    $($.root()).children().find('*').addBack().each((_, element) => {
      const $el = $(element);

      // Skip script and style elements early
      if (['script', 'style', 'noscript'].includes(element.tagName.toLowerCase())) {
        return;
      }

      const elementSelector = this.generateSelector($el);
      const selector = processSelector(elementSelector);

      // Process for interactive map
      if ($el.is('input, textarea, select, [type="search"], [contenteditable="true"], faceplate-search-input, *[role="searchbox"], *[role="textbox"]')) {
        interactive.push({
          type: 'input',
          inputType: $el.attr('type') || element.tagName.toLowerCase(),
          selector: selector,
          placeholder: $el.attr('placeholder'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          value: $el.attr('value'),
          name: $el.attr('name'),
          label: this.findAssociatedLabel($el)
        });
      }
  // Get clean text content by removing style/script elements first
      const getCleanText = ($elem) => {
        const $clone = $elem.clone();
        $clone.find('style, script').remove();
        return $clone.text().trim();
      };
      if ($el.is('button, [role="button"]')) {
        interactive.push({
          type: 'button',
          text: getCleanText($el),  // Use clean text here
          selector: selector,
          buttonType: $el.attr('type'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          disabled: $el.prop('disabled'),
          nearbyElementsText: this.getNearbyElementsText($el)
        });
      }

      if ($el.is('a')) {
        const text = $el.text().trim();
        const ariaLabel = $el.attr('aria-label');
        
        if (text || ariaLabel) {
          interactive.push({
            type: 'link',
            text: text,
            href: $el.attr('href'),
            selector: selector,
            id: $el.attr('id'),
            role: $el.attr('role'),
            'aria-label': ariaLabel
          });
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
          nearbyText,
          ...(element.tagName.toLowerCase() === 'a' && { href: $el.attr('href') })
        });
      }

      if (element.tagName.toLowerCase() === 'img') {
        content.push({
          type: 'media',
          mediaType: 'image',
          src: $el.attr('src'),
          alt: $el.attr('alt'),
          selector: selector,
          nearbyText
        });
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
            src: src || poster, // Use src if exists, fallback to poster
            sources: sources.length > 0 ? sources : undefined,
            selector: selector,
            nearbyText
          });
        }
      }
    });

    // Process shadow DOM
    if (shadowDOM) {
      shadowDOM.forEach((shadowTree) => {
        const $shadow = cheerio.load(shadowTree.content);
        const shadowMaps = this._generateMapsFromCheerio($shadow, null, null);
        
        // Process interactive elements
        Object.keys(shadowMaps.interactive).forEach(key => {
          shadowMaps.interactive[key].forEach(item => {
            const { selector, ...rest } = item;
            
            if (shadowTree.shadowTrees?.some(tree => 
              tree.hostElement.tagName.toLowerCase() === item.tag?.toLowerCase()
            )) {
              return;
            }

            interactive[key].push({
              ...rest,
              hostSelector: shadowTree.hostElement.tagName,
              shadowPath: [this.cleanShadowSelector(item.selector)]
            });
          });
        });

        // Process nested shadow DOMs
        if (shadowTree.shadowTrees) {
          shadowTree.shadowTrees.forEach(nestedShadow => {
            const $nestedShadow = cheerio.load(nestedShadow.content);
            const nestedMaps = this._generateMapsFromCheerio($nestedShadow, null, null);

            Object.keys(nestedMaps.interactive).forEach(key => {
              nestedMaps.interactive[key].forEach(item => {
                const { selector, ...rest } = item;
                interactive[key].push({
                  ...rest,
                  hostSelector: shadowTree.hostElement.tagName,
                  shadowPath: [
                    nestedShadow.hostElement.tagName,
                    this.cleanShadowSelector(item.selector)
                  ]
                });
              });
            });
          });
        }
      });
    }

    // Process iframes
    if (iframeData) {
      iframeData.forEach((iframe) => {
        const $iframe = cheerio.load(iframe.content);
        const iframeMaps = this._generateMapsFromCheerio($iframe, null, null, `iframe[src="${iframe.src}"]`);
        
        Object.keys(iframeMaps.interactive).forEach(key => {
          interactive[key].push(...iframeMaps.interactive[key]);
        });
        content.push(...iframeMaps.content);
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

  clearLatestDOMChanges() {
    console.log('Clearing latest DOM changes...');
    const clearedCount = this.latestDOMChanges.length;
    this.latestDOMChanges = [];
    console.log(`Cleared ${clearedCount} DOM changes`);
  }

  async getNewMapItems(page) {
    try {
      await this.captureSnapshot(page);
      const newContent = this.snapshot.content;
      const newInteractive = this.snapshot.interactive;

      // Save snapshot data
      fs.writeFileSync(
        path.join(__dirname, 'test', `debug_snapshot_${Date.now()}.json`),
        JSON.stringify({
          content: newContent,
          interactive: newInteractive
        }, null, 2)
      );

      // Log and save DOM changes before processing
      console.log('DOM Changes before processing:', {
        contentChangesCount: this.latestDOMChangesForContentElements.length,
        interactiveChangesCount: this.latestDOMChangesForInteractiveElements.length
      });

      fs.writeFileSync(
        path.join(__dirname, 'test', `debug_dom_changes_${Date.now()}.json`),
        JSON.stringify({
          content: this.latestDOMChangesForContentElements,
          interactive: this.latestDOMChangesForInteractiveElements
        }, null, 2)
      );

      // Create sets of selectors from DOM changes
      const changedContentSelectors = new Set(
        this.latestDOMChangesForContentElements.map(item => item.selector)
      );

      const changedInteractiveSelectors = new Set(
        this.latestDOMChangesForInteractiveElements.map(item => item.selector)
      );

      console.log('Selectors found:', {
        contentSelectorsCount: changedContentSelectors.size,
        interactiveSelectorsCount: changedInteractiveSelectors.size
      });

      // Filter new items using selectors
      const newItems = {
        content: newContent.filter(item => {
          const isNew = changedContentSelectors.has(item.selector);
          if (isNew) console.log('Found new content item:', {
            selector: item.selector,
            type: item.type,
            content: item.content || item.text
          });
          return isNew;
        }),
        interactive: newInteractive.filter(item => {
          const isNew = changedInteractiveSelectors.has(item.selector);
          if (isNew) console.log('Found new interactive item:', {
            selector: item.selector,
            type: item.type,
            text: item.text || item['aria-label']
          });
          return isNew;
        })
      };

      // Save filtered results
      fs.writeFileSync(
        path.join(__dirname, 'test', `debug_filtered_${Date.now()}.json`),
        JSON.stringify(newItems, null, 2)
      );

      console.log('Filtered results:', {
        newContentCount: newItems.content.length,
        newInteractiveCount: newItems.interactive.length
      });

      // Clear the changes arrays AFTER using them
      this.latestDOMChangesForContentElements = [];
      this.latestDOMChangesForInteractiveElements = [];

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
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    let browser;
    try {
      const url = 'https://google.com';
      // const url = 'https://twitter.com/elonmusk';
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
      const snapshot = new PageSnapshot();
      const result = await snapshot.captureSnapshot(page);
      
      console.log('\nSnapshot captured successfully!');
      console.log('Files saved with timestamp:', result.timestamp);
      
      // // Set up periodic content checking
      // console.log('\nStarting periodic content check...');
      // const checkInterval = setInterval(async () => {
      //   try {
      //     console.log('\nChecking for new content...');
      //     const newItems = await snapshot.getNewMapItems(page);
      //     console.log(`Found ${newItems.content.length} new content items`);
      //     console.log(`Found ${Object.values(newItems.interactive).flat().length} new interactive items`);
      //   } catch (error) {
      //     console.error('Error during content check:', error);
      //     clearInterval(checkInterval);
      //   }
      // }, 10000); // Check every 10 seconds

      // // Allow manual termination with Ctrl+C
      // process.on('SIGINT', () => {
      //   console.log('\nStopping content check...');
      //   clearInterval(checkInterval);
      //   if (browser) {
      //     browser.close();
      //   }
      //   process.exit(0);
      // });
   
    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
} 
