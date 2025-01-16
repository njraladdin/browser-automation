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
      const debugStartTime = Date.now();
      await this.saveDebugFiles();
      console.log(`Debug files saving took ${Date.now() - debugStartTime}ms`);

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
    const interactiveWithSelectors = JSON.parse(JSON.stringify(interactiveContent));
    
    // Add original selectors to each section
    ['inputs', 'buttons', 'links'].forEach(section => {
      interactiveWithSelectors[section] = interactiveWithSelectors[section].map(item => ({
        ...item,
        originalSelector: this.selectorToOriginalMap.get(item.selector)
      }));
    });
    
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
    console.log(`Debug file saving took ${Date.now() - startTime}ms`);
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
      await page.evaluate(() => {
        window.__domChanges = [];
        
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
                .filter(cls => 
                  !cls.match(/^(hover|focus|active)/) &&
                  !cls.includes('(') &&
                  !cls.includes(')') &&
                  !cls.includes('[') &&
                  !cls.includes(']')
                );
              
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
            // Skip style/script changes
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
                  changes: {
                    added: addedNode ? {
                      type: addedNode.nodeType === 1 ? 'element' : 'text',
                      content: addedNode.nodeType === 1 ? addedNode.outerHTML : addedNode.textContent
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

                // Only save if there were actual changes
                if (change.changes.added || change.changes.removed) {
                  window.__domChanges.push(change);
                }
              }
            } 
            else if (mutation.type === 'characterData') {
              // For text changes, only store the actual text difference
              const change = {
                type: 'characterData',
                timestamp: new Date().toISOString(),
                selectorPath: getElementPath(mutation.target),
                changes: {
                  oldValue: mutation.oldValue,
                  newValue: mutation.target.textContent
                },
                parentInfo: {
                  tagName: mutation.target.parentNode.tagName,
                  selectorPath: getElementPath(mutation.target.parentNode)
                }
              };
              
              window.__domChanges.push(change);
            }
          });
        });

        observer.observe(document.body, {
          childList: true,
          characterData: true,
          subtree: true,
          characterDataOldValue: true
        });

        window.__domObserver = observer;
      });

      // Set up periodic collection of changes
      this.changeCollectionInterval = setInterval(async () => {
        const changes = await page.evaluate(() => {
          const currentChanges = window.__domChanges;
          window.__domChanges = []; 
          return currentChanges;
        });

        if (changes && changes.length > 0) {
          try {
            console.log('Processing changes...');
            const processedChanges = changes.map(change => {
              let html = '';
              let baseSelector = '';
              if (change.type === 'childList') {
                const addedNode = change.changes.added;
                if (addedNode && addedNode.type === 'element') {
                  html = addedNode.content;
                  baseSelector = change.selectorPath;
                }
              }

              if (!html) {
                return null;  // Return null for changes without HTML content
              }

              const $ = cheerio.load(html, {
                xml: {
                  withDomLvl1: true,
                  xmlMode: false,
                },
                isDocument: false
              });
              
              const { interactive, content } = this._generateMapsFromCheerio($, null, null, baseSelector);
              
              // Only return changes that actually have content or interactive elements
              if (content.length === 0 && 
                  interactive.inputs.length === 0 && 
                  interactive.buttons.length === 0 && 
                  interactive.links.length === 0) {
                return null;
              }

              return {
                type: change.type,
                timestamp: change.timestamp,
                contentMap: content,
                interactiveMap: interactive
              };
            }).filter(change => change !== null);  // Filter out null changes

            // Only save if we have non-empty changes
            if (processedChanges.length > 0) {
              this.latestDOMChanges.push(...processedChanges);
              await this.logChangesToFile(processedChanges);
            }
          } catch (error) {
            console.error('Error processing changes:', error);
            await this.logChangesToFile(changes);
          }
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

  getContentMap() { 
    return this.snapshot.content; 
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
      - ${maps.interactive.inputs.length} inputs
      - ${maps.interactive.buttons.length} buttons 
      - ${maps.interactive.links.length} links
      - ${maps.content.length} content items
      Time taken: ${Date.now() - mapsStartTime}ms`);
    
    return maps;
  }

  _generateMapsFromCheerio($, shadowDOM = null, iframeData = null, baseSelector = '') {
    const startTime = Date.now();
    let lastTime = startTime;
    
    const logTimeDiff = (label) => {
      const now = Date.now();
      const diff = now - lastTime;
      const totalDiff = now - startTime;
      console.log(`${label} took ${diff}ms (total: ${totalDiff}ms)`);
      lastTime = now;
    };

    const interactive = {
      inputs: [],
      buttons: [],
      links: [],
    };
    const content = [];

    // Log initial setup time
    logTimeDiff('Initial setup');

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

    logTimeDiff('Selector processor setup');

    // Count total elements before processing
    const totalElements = $($.root()).find('*').length;
    console.log(`Processing ${totalElements} elements...`);

    // Process elements - use root() instead of body to avoid html > body prefix
    let processedCount = 0;
    const batchSize = 1000;
    const logProgress = () => {
      console.log(`Processed ${processedCount}/${totalElements} elements (${Math.round(processedCount/totalElements*100)}%)`);
    };

    $($.root()).children().find('*').addBack().each((_, element) => {
      const $el = $(element);
      
      // Skip script and style elements early
      if (['script', 'style', 'noscript'].includes(element.tagName.toLowerCase())) {
        processedCount++;
        return;
      }

      // Generate selector directly from the element
      const elementSelector = this.generateSelector($el);
      const selector = processSelector(elementSelector);

      // Process for interactive map
      if ($el.is('input, textarea, select, [type="search"], [contenteditable="true"], faceplate-search-input, *[role="searchbox"], *[role="textbox"]')) {
        interactive.inputs.push({
          type: $el.attr('type') || element.tagName.toLowerCase(),
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

      if ($el.is('button, [role="button"]')) {
        interactive.buttons.push({
          text: $el.text().trim(),
          selector: selector,
          type: $el.attr('type'),
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
          interactive.links.push({
            text: text,
            href: $el.attr('href'),
            selector: selector,
            id: $el.attr('id'),
            role: $el.attr('role'),
            'aria-label': ariaLabel
          });
        }
      }

      // Process for content map
      const directText = $el.clone().children().remove().end().text().trim();
      if (directText) {
        content.push({
          type: element.tagName.toLowerCase() === 'a' ? 'link' : 'text',
          content: directText,
          tag: element.tagName.toLowerCase(),
          selector: selector
        });
      }

      if (element.tagName.toLowerCase() === 'img') {
        content.push({
          type: 'media',
          mediaType: 'image',
          src: $el.attr('src'),
          alt: $el.attr('alt'),
          selector: selector
        });
      } else if (element.tagName.toLowerCase() === 'video') {
        content.push({
          type: 'media',
          mediaType: 'video',
          src: $el.attr('src'),
          poster: $el.attr('poster'),
          selector: selector
        });
      }

      processedCount++;
      if (processedCount % batchSize === 0) {
        logProgress();
        logTimeDiff(`Processed batch of ${batchSize} elements`);
      }
    });

    logTimeDiff('Main element processing');

    // Process shadow DOM
    if (shadowDOM) {
      console.log(`Processing ${shadowDOM.length} shadow DOM trees...`);
      shadowDOM.forEach((shadowTree, index) => {
        console.log(`Processing shadow DOM tree ${index + 1}/${shadowDOM.length}`);
        const $shadow = cheerio.load(shadowTree.content);
        const shadowMaps = this._generateMapsFromCheerio($shadow, null, null);
        
        // Process interactive elements
        Object.keys(shadowMaps.interactive).forEach(key => {
          shadowMaps.interactive[key].forEach(item => {
            const { selector, ...rest } = item;
            
            // If this element has its own shadow DOM, skip it - we'll process it in nested loop
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
      logTimeDiff('Shadow DOM processing');
    }

    // Process iframes
    if (iframeData) {
      console.log(`Processing ${iframeData.length} iframes...`);
      iframeData.forEach((iframe, index) => {
        console.log(`Processing iframe ${index + 1}/${iframeData.length}`);
        const $iframe = cheerio.load(iframe.content);
        const iframeMaps = this._generateMapsFromCheerio($iframe, null, null, `iframe[src="${iframe.src}"]`);
        
        // Add iframe paths...
        Object.keys(iframeMaps.interactive).forEach(key => {
          interactive[key].push(...iframeMaps.interactive[key]);
        });
        content.push(...iframeMaps.content);
      });
      logTimeDiff('Iframe processing');
    }

    const timeTaken = Date.now() - startTime;
    console.log(`Cheerio map generation completed in ${timeTaken}ms${baseSelector ? ` for ${baseSelector}` : ''}`);
    console.log(`Final counts:
      - Inputs: ${interactive.inputs.length}
      - Buttons: ${interactive.buttons.length}
      - Links: ${interactive.links.length}
      - Content items: ${content.length}
    `);
    
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
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    let browser;
    try {
      const url = 'https://www.airbnb.com';
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
      
   
    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    } finally {
     
    }
  })();
} 
