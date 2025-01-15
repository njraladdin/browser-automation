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
      timestamp: null,
      textView: null
    };
    this.latestDOMChanges = [];
    this.observer = null;
  }

  async captureSnapshot(page) {
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
      this.cleanPage();
      this.snapshot.html = this.getCleanedHtml();

      // Replace separate map generations with single combined call
      const maps = await this.generatePageMaps(page);
      this.snapshot.interactive = maps.interactive;
      this.snapshot.content = maps.content;
      
      // Set timestamp
      this.snapshot.timestamp = new Date().toISOString();

      // Generate raw text view
      this.snapshot.textView = this.generateTextView();

      // Save debug files
      await this.saveDebugFiles();

      // Start observing DOM changes AFTER capturing the snapshot
      console.log('Starting DOM observer to track post-snapshot changes...');
      await this.startDOMObserver(page);

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
  getTextView() { return this.snapshot.textView; }
  
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
    const id = $el.attr('id');
    if (id) {
      const safeId = this.sanitizeSelector(id);
      if (safeId && this.$(`#${safeId}`).length === 1) return `#${safeId}`;
    }

    // Build the full path from the element up to a unique ancestor or root
    const path = [];
    let current = $el;
    let foundUniqueAncestor = false;

    while (current.length && !foundUniqueAncestor) {
      let selector = current[0].tagName.toLowerCase();
      
      // Add id if present
      const currentId = current.attr('id');
      if (currentId) {
        const safeId = this.sanitizeSelector(currentId);
        selector = `#${safeId}`;
        foundUniqueAncestor = true;
      } else {
        // Add classes that help identify the element
        const classes = current.attr('class');
        if (classes) {
          const safeClasses = classes.split(/\s+/)
            .filter(cls => 
              // Only include basic classes, avoid dynamic/complex ones
              cls && 
              !cls.match(/^(hover|focus|active)/) &&
              !cls.includes('(') &&
              !cls.includes(')') &&
              !cls.includes('[') &&
              !cls.includes(']') &&
              !cls.includes('\\') &&
              !cls.includes('/') &&
              !cls.includes(':')
            )
            .map(cls => this.sanitizeSelector(cls));

          if (safeClasses.length) {
            selector += '.' + safeClasses.join('.');
          }
        }

        // Add nth-child if there are siblings
        try {
          const siblings = current.siblings(selector).add(current);
          if (siblings.length > 1) {
            const index = siblings.index(current) + 1;
            selector += `:nth-child(${index})`;
          }
        } catch (e) {
          // If selector is invalid, just use the tag name with nth-child
          const index = current.parent().children().index(current) + 1;
          selector = `${current[0].tagName.toLowerCase()}:nth-child(${index})`;
        }
      }

      // Validate selector before adding it
      try {
        this.$(selector);
        path.unshift(selector);
      } catch (e) {
        // If invalid, fall back to basic tag selector with nth-child
        const index = current.parent().children().index(current) + 1;
        path.unshift(`${current[0].tagName.toLowerCase()}:nth-child(${index})`);
      }

      current = current.parent();

      // Check if we've found a unique ancestor
      try {
        if (current.length && path.length > 0) {
          const testSelector = path.join(' > ');
          if (this.$(testSelector).length === 1) {
            foundUniqueAncestor = true;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Final validation of the complete selector
    try {
      const finalSelector = path.join(' > ');
      this.$(finalSelector); // Test if valid
      return finalSelector;
    } catch (e) {
      // Ultimate fallback - just return a very basic selector
      return `${$el[0].tagName.toLowerCase()}:nth-child(${$el.parent().children().index($el) + 1})`;
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
    const htmlContent = await Promise.resolve(this.snapshot.html);
    const interactiveContent = await Promise.resolve(this.snapshot.interactive);
    const textViewContent = await Promise.resolve(this.snapshot.textView);

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

    fs.writeFileSync(
      path.join(testDir, `text_view_${timestamp}.txt`),
      textViewContent,
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

  async generateTextView(page) {
    if (!this.$) {
      console.log('Loading page HTML for text view generation...');
      await this.loadPageHtml(page);
    }
console.log('html loaded')
    // Clean main document HTML - only body content
    this.$('body *').each((_, el) => {
      const $el = this.$(el);
      const attrs = Object.keys(el.attribs || {});
      
      // Remove all attributes except src, aria-label, and href
      attrs.forEach(attr => {
        if (attr !== 'src' && attr !== 'aria-label' && attr !== 'href') {
          $el.removeAttr(attr);
        }
      });
    });
    
    let fullSource = this.$('body').html();
    
    // Add shadow DOM content
    if (this.snapshot.shadowDOM) {
      this.snapshot.shadowDOM.forEach(shadow => {
        const $shadow = cheerio.load(shadow.content);
        
        // Clean attributes in shadow DOM
        $shadow('*').each((_, el) => {
          const $el = $shadow(el);
          const attrs = Object.keys(el.attribs || {});
          
          attrs.forEach(attr => {
            if (attr !== 'src' && attr !== 'aria-label' && attr !== 'href') {
              $el.removeAttr(attr);
            }
          });
        });
        
        fullSource += $shadow.html();
      });
    }

    // Add iframe content
    if (this.snapshot.iframeData) {
      this.snapshot.iframeData.forEach(iframe => {
        const $iframe = cheerio.load(iframe.content);
        // Clean iframe content attributes
        $iframe('*').each((_, el) => {
          const $el = $iframe(el);
          const attrs = Object.keys(el.attribs || {});
          attrs.forEach(attr => {
            if (attr !== 'src' && attr !== 'aria-label' && attr !== 'href') {
              $el.removeAttr(attr);
            }
          });
        });
        fullSource += $iframe.html();
      });
    }

    // Remove common HTML tags but keep important attributes and all content
    return fullSource
      // Simple tag removals for elements with attributes we want to keep
      .replace(/<a/g, '')
      .replace(/<div/g, '')
      .replace(/<button/g, '')
      .replace(/<img/g, '')
      .replace(/<picture/g, '')
      .replace(/<\/button>/g, '')
      .replace(/<\/div>/g, '')
      .replace(/<\/a>/g, '')
      .replace(/<\/picture>/g, '')
      // Remove other common elements
      .replace(/<\/?span>/g, '')
      .replace(/<\/?p>/g, '')
      .replace(/<\/?section>/g, '')
      .replace(/<\/?article>/g, '')
      .replace(/<\/?main>/g, '')
      .replace(/<\/?header>/g, '')
      .replace(/<\/?footer>/g, '')
      .replace(/<\/?nav>/g, '')
      .replace(/<\/?aside>/g, '')
      .replace(/<\/?ul>/g, '')
      .replace(/<\/?ol>/g, '')
      .replace(/<\/?li>/g, '')
      .replace(/<\/?h[1-6]>/g, '')
      .replace(/<\/?strong>/g, '')
      .replace(/<\/?em>/g, '')
      .replace(/<\/?i>/g, '')
      .replace(/<\/?b>/g, '')
      .replace(/<\/?small>/g, '')
      .replace(/<\/?br>/g, '\n')
      .replace(/<\/?hr>/g, '\n---\n')
      .replace(/<\/?input[^>]*>/g, '')
      .replace(/<\/?label[^>]*>/g, '')
      .replace(/>/g, '')
      // Clean up excess whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  async loadPageHtml(page) {
    try {
      const html = await page.content();
      this.$ = cheerio.load(html, {
        decodeEntities: true,
        xmlMode: false
      });
    } catch (error) {
      console.error('Failed to load page HTML:', error);
      throw error;
    }
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

            if (mutation.type === 'attributes') {
              return;
            }

            let relevantHTML;
            let selectorPath = getElementPath(mutation.target);
            
            if (mutation.type === 'childList') {
              relevantHTML = mutation.target.outerHTML;
            } else if (mutation.type === 'characterData') {
              relevantHTML = mutation.target.parentNode.outerHTML;
              selectorPath = getElementPath(mutation.target.parentNode);
            }

            // Check for duplicates
            const isDuplicate = window.__domChanges.some(existingChange => {
              const existingHTML = existingChange.containerHTML || 
                                 existingChange.elementHTML || 
                                 (existingChange.addedNodes && existingChange.addedNodes.some(node => node.html === relevantHTML));
              return existingHTML === relevantHTML;
            });

            if (!isDuplicate) {
              const change = {
                type: mutation.type,
                timestamp: new Date().toISOString(),
                selectorPath,
                target: {
                  tagName: mutation.target.tagName,
                  id: mutation.target.id,
                  className: mutation.target.className
                }
              };

              if (mutation.type === 'childList') {
                change.html = mutation.target.outerHTML;
                change.addedNodes = Array.from(mutation.addedNodes).map(node => ({
                  tagName: node.tagName,
                  id: node.id,
                  className: node.className,
                  html: node.outerHTML || node.textContent || null,
                  selectorPath: node.nodeType === 1 ? getElementPath(node) : null
                }));
                
                change.removedNodes = Array.from(mutation.removedNodes).map(node => ({
                  tagName: node.tagName,
                  id: node.id,
                  className: node.className,
                  selectorPath: node.nodeType === 1 ? getElementPath(node) : null
                }));
              } else if (mutation.type === 'characterData') {
                change.oldValue = mutation.oldValue;
                change.newValue = mutation.target.textContent;
                change.html = mutation.target.parentNode.outerHTML;
              }

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
              const $ = cheerio.load(change.html);
              
              // Use our existing map generator but maintain original structure
              const { interactive, content } = this._generateMapsFromCheerio($);
              
              return {
                ...change,
                contentMap: content,           // Keep original property name
                interactiveMap: interactive    // Keep original property name
              };
            });

            this.latestDOMChanges.push(...processedChanges);
            await this.logChangesToFile(processedChanges);
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
    const maps = await this._generateMapsFromCheerio(
      this.$, 
      this.snapshot.shadowDOM,
      this.snapshot.iframeData
    );
    
    this.snapshot.interactive = maps.interactive;
    this.snapshot.content = maps.content;
    
    return maps;
  }

  _generateMapsFromCheerio($, shadowDOM = null, iframeData = null) {
    const interactive = {
      inputs: [],
      buttons: [],
      links: [],
    };
    const content = [];

    // Helper function to process selector
    const processSelector = (originalSelector) => {
      if (originalSelector.length <= 500) {
        return originalSelector;
      }
      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, originalSelector);
      return shortSelector;
    };

    // Process main document elements
    $('body *').each((_, element) => {
      const $el = $(element);
      
      // Skip script and style elements
      if (['script', 'style', 'noscript'].includes(element.tagName.toLowerCase())) {
        return;
      }

      const originalSelector = this.generateSelector($el);
      const selector = processSelector(originalSelector);

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
          type: 'text',
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

      const isStructural = ['main', 'article', 'section', 'header', 'footer', 'nav', 'aside'].includes(element.tagName.toLowerCase());
      if (isStructural) {
        content.push({
          type: 'structure',
          tag: element.tagName.toLowerCase(),
          role: $el.attr('role'),
          selector: selector,
          'aria-label': $el.attr('aria-label')
        });
      }
    });

    // Process shadow DOM
    if (shadowDOM) {
      shadowDOM.forEach(shadowTree => {
        const $shadow = cheerio.load(shadowTree.content);
        const shadowMaps = this._generateMapsFromCheerio($shadow);
        
        const currentPath = `${shadowTree.hostElement.tagName} > shadow-root`;
        
        // Add shadow paths to interactive elements
        Object.keys(shadowMaps.interactive).forEach(key => {
          shadowMaps.interactive[key].forEach(item => {
            item.shadowPath = `${currentPath} > ${item.selector}`;
            item.selector = `${shadowTree.hostElement.tagName} > shadow-root > ${item.selector}`;
            interactive[key].push(item);
          });
        });

        // Add shadow paths to content elements
        shadowMaps.content.forEach(item => {
          item.shadowPath = `${currentPath} > ${item.tag}`;
          item.selector = `${shadowTree.hostElement.tagName} > shadow-root > ${item.selector}`;
          content.push(item);
        });
      });
    }

    // Process iframes
    if (iframeData) {
      iframeData.forEach(iframe => {
        const $iframe = cheerio.load(iframe.content);
        const iframeMaps = this._generateMapsFromCheerio($iframe);
        
        // Add iframe paths to interactive elements
        Object.keys(iframeMaps.interactive).forEach(key => {
          iframeMaps.interactive[key].forEach(item => {
            item.iframePath = `iframe[src="${iframe.src}"] > ${item.selector}`;
            item.selector = `iframe[src="${iframe.src}"] > ${item.selector}`;
            interactive[key].push(item);
          });
        });

        // Add iframe paths to content elements
        iframeMaps.content.forEach(item => {
          item.iframePath = `iframe[src="${iframe.src}"] > ${item.tag}`;
          item.selector = `iframe[src="${iframe.src}"] > ${item.selector}`;
          content.push(item);
        });
      });
    }

    return { interactive, content };
  }
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    let browser;
    try {
      const url = 'https://www.anonyig.com';
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