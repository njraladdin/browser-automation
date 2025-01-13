const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
      timestamp: null,
      textView: null
    };
  }

  async captureSnapshot(page) {
    try {


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

      // Generate analysis data
      const { view: interactiveView } = await this.generateInteractiveView(page);
      this.snapshot.interactive = interactiveView;
      
      // Set timestamp
      this.snapshot.timestamp = new Date().toISOString();

      // Generate raw text view
      this.snapshot.textView = this.generateTextView();

      // Save debug files
      await this.saveDebugFiles();

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

  async generateInteractiveView(page) {
    this.selectorCounter = 0;
    this.selectorToOriginalMap.clear();
    const interactiveView = {
      inputs: [],
      buttons: [],
      links: [],
      textContent: []
    };

    // Modify the shadow DOM parsing section
    const parseShadowContent = (shadowTree, parentPath = '') => {
      const temp = this.$('<div>').html(shadowTree.content);
      const currentPath = `${parentPath} > ${shadowTree.hostElement.tagName} > shadow-root`;

      temp.find('input, textarea, select').each((_, el) => {
        const $el = this.$(el);
        const originalSelector = `${shadowTree.hostElement.tagName} > input[type="${$el.attr('type')}"]`;
        
        const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
        this.selectorToOriginalMap.set(shortSelector, originalSelector);
        
        interactiveView.inputs.push({
          type: $el.attr('type') || el.tagName.toLowerCase(),
          selector: shortSelector,
          placeholder: $el.attr('placeholder'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          value: $el.attr('value'),
          name: $el.attr('name'),
          shadowPath: `${currentPath} > ${el.tagName.toLowerCase()}`
        });
      });

      // Similar changes for buttons in shadow DOM
      temp.find('button, [role="button"]').each((_, el) => {
        const $el = this.$(el);
        const originalSelector = `${shadowTree.hostElement.tagName} > button`;
        
        const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
        this.selectorToOriginalMap.set(shortSelector, originalSelector);
        
        interactiveView.buttons.push({
          text: $el.text().trim(),
          selector: shortSelector,
          type: $el.attr('type'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          disabled: $el.prop('disabled'),
          shadowPath: `${currentPath} > ${el.tagName.toLowerCase()}`,
          nearbyElementsText: this.getNearbyElementsText($el)
        });
      });

      // Similar changes for links in shadow DOM
      temp.find('a').each((_, el) => {
        const $el = this.$(el);
        const text = $el.text().trim();
        const ariaLabel = $el.attr('aria-label');
        
        // Skip links that don't have text content or aria-label
        if (!text && !ariaLabel) return;

        const originalSelector = `${shadowTree.hostElement.tagName} > a`;
        
        const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
        this.selectorToOriginalMap.set(shortSelector, originalSelector);
        
        interactiveView.links.push({
          text: text,
          href: $el.attr('href'),
          selector: shortSelector,
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': ariaLabel,
          shadowPath: `${currentPath} > ${el.tagName.toLowerCase()}`
        });
      });

      shadowTree.shadowTrees.forEach(nestedTree => {
        parseShadowContent(nestedTree, currentPath);
      });
    };

    // Process all shadow trees first
    this.snapshot.shadowDOM.forEach(shadowTree => {
      parseShadowContent(shadowTree);
    });

    // Then process regular DOM elements
    this.$('input, textarea, select, [type="search"], [contenteditable="true"], faceplate-search-input, *[role="searchbox"], *[role="textbox"]').each((index, el) => {
      const $el = this.$(el);
      const originalSelector = this.generateSelector($el);

      const getAttr = (attr) => {
        return $el.attr(attr) || $el.find(`[${attr}]`).first().attr(attr);
      };

      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, originalSelector);
      
      interactiveView.inputs.push({
        type: getAttr('type') || el.tagName.toLowerCase(),
        selector: shortSelector,
        placeholder: getAttr('placeholder'),
        id: getAttr('id'),
        role: getAttr('role'),
        'aria-label': getAttr('aria-label'),
        value: getAttr('value'),
        name: getAttr('name'),
        label: this.findAssociatedLabel($el)
      });
    });

    // Process regular buttons
    this.$('button, [role="button"]').each((index, el) => {
      const $el = this.$(el);
      const originalSelector = this.generateSelector($el);

      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, originalSelector);
      
      interactiveView.buttons.push({
        text: $el.text().trim(),
        selector: shortSelector,
        type: $el.attr('type'),
        id: $el.attr('id'),
        role: $el.attr('role'),
        'aria-label': $el.attr('aria-label'),
        disabled: $el.prop('disabled'),
        nearbyElementsText: this.getNearbyElementsText($el)
      });
    });

    // Process regular links
    this.$('a').each((index, el) => {
      const $el = this.$(el);
      const text = $el.text().trim();
      const ariaLabel = $el.attr('aria-label');
      
      // Skip links that don't have text content or aria-label
      if (!text && !ariaLabel) return;

      const originalSelector = this.generateSelector($el);

      const shortSelector = `__SELECTOR__${++this.selectorCounter}`;
      this.selectorToOriginalMap.set(shortSelector, originalSelector);
      
      interactiveView.links.push({
        text: text,
        href: $el.attr('href'),
        selector: shortSelector,
        id: $el.attr('id'),
        role: $el.attr('role'),
        'aria-label': ariaLabel
      });
    });

    // Update to only store interactive view once
    this.snapshot.interactive = interactiveView;

    return {
      view: interactiveView
    };
  }

  generateSelector($el) {
    const id = $el.attr('id');
    if (id && this.$(`#${id}`).length === 1) return `#${id}`;

    // Build the full path from the element up to a unique ancestor or root
    const path = [];
    let current = $el;
    let foundUniqueAncestor = false;

    // Helper to sanitize class names
    const sanitizeClassName = (className) => {
      return className
        .replace(/[^\w-]/g, '_') // Replace any non-word chars (except hyphens) with underscore
        .replace(/^(\d)/, '_$1'); // Prefix with underscore if starts with number
    };

    while (current.length && !foundUniqueAncestor) {
      let selector = current[0].tagName.toLowerCase();
      
      // Add id if present
      const currentId = current.attr('id');
      if (currentId) {
        selector = `#${sanitizeClassName(currentId)}`;
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
              !cls.includes('\\')
            )
            .map(sanitizeClassName);

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

      try {
        // Test if the selector is valid before adding it
        this.$(selector);
        path.unshift(selector);
      } catch (e) {
        // If invalid, fall back to basic tag selector
        path.unshift(current[0].tagName.toLowerCase());
      }

      current = current.parent();

      // Try to find a unique ancestor, but with error handling
      try {
        if (current.length && path.length > 0) {
          const testSelector = path.join(' > ');
          if (this.$(testSelector).length === 1) {
            foundUniqueAncestor = true;
          }
        }
      } catch (e) {
        // If the selector is invalid, continue with the next iteration
        continue;
      }
    }

    try {
      return path.join(' > ');
    } catch (e) {
      // Fallback to a very basic selector if everything else fails
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
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    let browser;
    try {
      const url = 'https://reddit.com';
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
      console.log('\nDebug files location:', path.join(__dirname, 'test'));

    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    } finally {
      if (browser) {
        await browser.close();
        console.log('\nBrowser closed. Test complete!');
      }
    }
  })();
} 