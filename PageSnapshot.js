const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

class PageSnapshot {
  constructor() {
    this.$ = null;
    this.selectorMap = new Map();
    this.snapshot = {
      url: null,
      html: null,
      skeletonView: null,
      interactive: null,
      fullInteractive: null,
      selectorMap: null,
      timestamp: null
    };
  }

  async captureSnapshot(page) {
    // Capture current URL
    this.snapshot.url = await page.url();
    
    // Capture both regular HTML and shadow DOM content
    const { html, shadowDOMData } = await page.evaluate(() => {
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
      
      return {
        html: document.documentElement.outerHTML,
        shadowDOMData: captureShadowDOM(document)
      };
    });

    // Store the complete shadow DOM data
    this.snapshot.shadowDOM = shadowDOMData;

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
    this.snapshot.fullInteractive = interactiveView;
    this.snapshot.interactive = interactiveView;
    this.snapshot.selectorMap = {};
    
    // Set timestamp
    this.snapshot.timestamp = new Date().toISOString();

    // Generate skeleton view after cleaning the page
    this.snapshot.skeletonView = this.generateSkeletonView();

    // Save debug files
    await this.saveDebugFiles();

    return this.snapshot;
  }

  // Get methods for accessing snapshot data
  getUrl() { return this.snapshot.url; }
  getHtml() { return this.snapshot.html; }
  getInteractiveView() { return this.snapshot.interactive; }
  getFullInteractiveView() { return this.snapshot.fullInteractive; }
  getSelectorMap() { return this.snapshot.selectorMap; }
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

  async generateInteractiveView(page) {
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
        const selector = `${shadowTree.hostElement.tagName} > input[type="${$el.attr('type')}"]`;
        
        interactiveView.inputs.push({
          type: $el.attr('type') || el.tagName.toLowerCase(),
          selector: selector, // Just use the full selector directly
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
        const selector = `${shadowTree.hostElement.tagName} > button`;
        
        interactiveView.buttons.push({
          text: $el.text().trim(),
          selector: selector, // Just use the full selector directly
          type: $el.attr('type'),
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
          disabled: $el.prop('disabled'),
          shadowPath: `${currentPath} > ${el.tagName.toLowerCase()}`
        });
      });

      // Similar changes for links in shadow DOM
      temp.find('a').each((_, el) => {
        const $el = this.$(el);
        const selector = `${shadowTree.hostElement.tagName} > a`;
        
        interactiveView.links.push({
          text: $el.text().trim(),
          href: $el.attr('href'),
          selector: selector, // Just use the full selector directly
          id: $el.attr('id'),
          role: $el.attr('role'),
          'aria-label': $el.attr('aria-label'),
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
      const selector = this.generateSelector($el);

      const getAttr = (attr) => {
        return $el.attr(attr) || $el.find(`[${attr}]`).first().attr(attr);
      };

      interactiveView.inputs.push({
        type: getAttr('type') || el.tagName.toLowerCase(),
        selector: selector, // Just use the full selector directly
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
      const selector = this.generateSelector($el);

      interactiveView.buttons.push({
        text: $el.text().trim(),
        selector: selector, // Just use the full selector directly
        type: $el.attr('type'),
        id: $el.attr('id'),
        role: $el.attr('role'),
        'aria-label': $el.attr('aria-label'),
        disabled: $el.prop('disabled')
      });
    });

    // Process regular links
    this.$('a').each((index, el) => {
      const $el = this.$(el);
      const selector = this.generateSelector($el);

      interactiveView.links.push({
        text: $el.text().trim(),
        href: $el.attr('href'),
        selector: selector, // Just use the full selector directly
        id: $el.attr('id'),
        role: $el.attr('role'),
        'aria-label': $el.attr('aria-label')
      });
    });

    return {
      view: interactiveView
    };
  }

  generateSelector($el) {
    const id = $el.attr('id');
    if (id) return `#${id}`;

    const tag = $el[0].tagName.toLowerCase();
    let selector = tag;
    
    // Handle custom elements and their children
    if (tag.includes('-')) {
      const name = $el.attr('name');
      const type = $el.attr('type');
      
      if (name) selector += `[name="${name}"]`;
      if (type) selector += `[type="${type}"]`;
      
      if ($el.hasClass('search-input')) {
        selector += '.search-input';
      }
      
      return selector;
    }

    // For regular elements, combine both approaches
    const type = $el.attr('type');
    const name = $el.attr('name');
    const role = $el.attr('role');
    const href = $el.attr('href');
    
    // Add essential attributes
    if (href) selector += `[href="${href}"]`;
    if (type) selector += `[type="${type}"]`;
    if (name) selector += `[name="${name}"]`;
    if (role) selector += `[role="${role}"]`;

    // Filter and add safe CSS classes
    const classes = $el.attr('class');
    if (classes) {
      // Only keep truly safe classes
      const safeClasses = classes.split(/\s+/).filter(cls => {
        // Keep only simple classes without any special characters or Tailwind patterns
        return /^[a-zA-Z0-9_-]+$/.test(cls) && 
          !cls.startsWith('hover-') &&
          !cls.startsWith('focus-') &&
          !cls.startsWith('active-') &&
          !cls.match(/^(w|h|p|m|px|py|mx|my|gap|space|text|bg|border|rounded|flex|grid|items|justify)/);
      });

      if (safeClasses.length) {
        selector += '.' + safeClasses.join('.');
      }
    }

    // Instead of :contains, use aria-label or title if available
    const ariaLabel = $el.attr('aria-label');
    const title = $el.attr('title');
    if (ariaLabel) selector += `[aria-label="${ariaLabel}"]`;
    else if (title) selector += `[title="${title}"]`;

    return selector;
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
    
    fs.writeFileSync(
      path.join(testDir, `page_${timestamp}.html`),
      this.snapshot.html,
      'utf8'
    );

    fs.writeFileSync(
      path.join(testDir, `interactive_${timestamp}.json`),
      JSON.stringify(this.snapshot.fullInteractive, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(testDir, `skeleton_${timestamp}.html`),
      this.snapshot.skeletonView,
      'utf8'
    );

    console.log(`Debug files saved with timestamp: ${timestamp}`);
    return timestamp;
  }

  generateSkeletonView() {
    // Create a deep clone of the current DOM
    const $skeleton = cheerio.load(this.$.html());
    
    // Remove all link elements
    $skeleton('link').remove();
    
    // Remove HTML comments
    $skeleton('*').contents().each((i, el) => {
      if (el.type === 'comment') {
        $skeleton(el).remove();
      }
    });


    // Function to get element's structure signature
    const getElementSignature = ($el) => {
      const tag = $el.prop('tagName')?.toLowerCase() || '';
      const structure = $el.children()
        .map((_, child) => {
          const $child = $skeleton(child);
          return $child.prop('tagName')?.toLowerCase() || '';
        })
        .get()
        .join(',');
      
      return `${tag}[${structure}]`;
    };

    // Find repeating elements in any container
    $skeleton('*').each((_, container) => {
      const $container = $skeleton(container);
      const children = $container.children().toArray();
      
      if (children.length >= 4) {
        let repeatingGroups = [];
        let currentGroup = [children[0]];
        const firstSignature = getElementSignature($skeleton(children[0]));
        
        // Group consecutive elements with same structure
        for (let i = 1; i < children.length; i++) {
          const currentSignature = getElementSignature($skeleton(children[i]));
          if (currentSignature === firstSignature) {
            currentGroup.push(children[i]);
          } else {
            if (currentGroup.length >= 3) {
              repeatingGroups.push(currentGroup);
            }
            currentGroup = [children[i]];
          }
        }
        
        // Handle last group
        if (currentGroup.length >= 3) {
          repeatingGroups.push(currentGroup);
        }

        // Replace repeating elements with first, comment, and last
        repeatingGroups.forEach(group => {
          const count = group.length;
          if (count >= 3) {
            const $first = $skeleton(group[0]);
            const $last = $skeleton(group[count - 1]);
            
            // Remove middle elements
            for (let i = 1; i < count - 1; i++) {
              $skeleton(group[i]).remove();
            }
            
            // Insert comment between first and last
            $first.after(`<!-- ${count - 2} similar elements -->`) 
          }
        });
      }
    });

    // Process attributes (your existing attribute processing code)
    $skeleton('*').each((i, el) => {
      const $el = $skeleton(el);
      const attributes = Object.keys(el.attribs || {});
      
      attributes.forEach(attr => {
        const keepAttributes = ['type', 'href', 'role', 'target', 'rel', 'for', 'value', 'action', 'aria-label'];
       if (!keepAttributes.includes(attr)) {
          $el.removeAttr(attr);
        }
      });
    });

    return $skeleton.html()
      .replace(/\s+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
  }
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');

  (async () => {
    try {
      // Get URL from command line argument or use default
      const url = 'https://reddit.com';
      console.log(`Testing PageSnapshot with URL: ${url}`);

      // Launch browser
      console.log('Launching browser...');
      const browser = await puppeteer.launch({ 
        headless: false,
        defaultViewport: {
          width: 1280,
          height: 800
        }
      });

      // Create new page and navigate
      const page = await browser.newPage();
      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

      // Take snapshot
      console.log('Taking page snapshot...');
      const snapshot = new PageSnapshot();
      const result = await snapshot.captureSnapshot(page);
      
      console.log('\nSnapshot captured successfully!');
      console.log('Files saved with timestamp:', result.timestamp);
      console.log('\nDebug files location:', path.join(__dirname, 'test'));

      // Close browser
      await browser.close();
      console.log('\nBrowser closed. Test complete!');

    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
} 