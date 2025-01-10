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
      // First check if we're expecting a navigation
      const navigationPromise = page.waitForNavigation({ 
        waitUntil: 'networkidle2', 
        timeout: 20000 
      }).catch(() => {
        console.log('No navigation occurred or timeout reached');
      });

      // Wait for either navigation to complete or timeout
      await navigationPromise;

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
          shadowPath: `${currentPath} > ${el.tagName.toLowerCase()}`
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
        disabled: $el.prop('disabled')
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

    while (current.length && !foundUniqueAncestor) {
      let selector = current[0].tagName.toLowerCase();
      
      // Add id if present
      const currentId = current.attr('id');
      if (currentId) {
        selector = `#${currentId}`;
        foundUniqueAncestor = true;
      } else {
        // Add classes that help identify the element
        const classes = current.attr('class');
        if (classes) {
          const safeClasses = classes.split(/\s+/).filter(cls => 
            /^[a-zA-Z0-9_-]+$/.test(cls) && !cls.match(/^(hover|focus|active)/));
          if (safeClasses.length) {
            selector += '.' + safeClasses.join('.');
          }
        }

        // Add nth-child if there are siblings
        const siblings = current.siblings(selector).add(current);
        if (siblings.length > 1) {
          const index = siblings.index(current) + 1;
          selector += `:nth-child(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parent();

      // Stop if we've reached a unique ancestor
      if (current.length && this.$(path.join(' > ')).length === 1) {
        foundUniqueAncestor = true;
      }
    }

    return path.join(' > ');
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
      JSON.stringify(this.snapshot.interactive, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(testDir, `text_view_${timestamp}.txt`),
      this.snapshot.textView,
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

  generateTextView() {
    // Clean main document HTML - only body content
    const $main = this.$;
    $main('body *').each((_, el) => {
      const $el = $main(el);
      const attrs = Object.keys(el.attribs || {});
      
      // Remove all attributes except src, aria-label, and href
      attrs.forEach(attr => {
        if (attr !== 'src' && attr !== 'aria-label' && attr !== 'href') {
          $el.removeAttr(attr);
        }
      });
    });
    
    let fullSource = $main('body').html();
    
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

  async parseTextViewWithAI(structurePrompt) {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not found in environment variables');
      }
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-8b",
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      });

      const textContent = this.generateTextView();

      const systemPrompt = `You are an AI assistant that parses webpage text content and extracts structured information.

Input Text Content from Webpage:
${textContent}

Instructions for Parsing:
${structurePrompt}

Please provide your response in the following JSON format:
{
  "items": [
    // Each item should be an object with properly separated key-value pairs
    // Example structures for different types of content:
    
    // Product listing example:
    {
      "name": "string",
      "price": "string",
      "brand": "string",
      "category": "string",
      "rating": "string",
      "reviews_count": "string",
      "specifications": ["string"],
      "in_stock": true,
      "is_on_sale": false,
      "has_warranty": true,
      "free_shipping": true
    },
    
    // Article/News example:
    {
      "title": "string",
      "author": "string",
      "date": "string",
      "category": "string",
      "summary": "string",
      "tags": ["string"],
      "read_time": "string",
      "is_premium": false,
      "is_featured": true,
      "comments_enabled": true,
      "breaking_news": false
    }
  ]
}

Important:
- Ensure the response is valid JSON
- Split all information into appropriate key-value pairs
- Use clear, descriptive keys for each piece of information
- Don't combine different types of information into single fields
- Keep data well-structured and organized
- We need to extract as much relevant data as possible`;

      // Generate response from Gemini
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: systemPrompt }]}]
      });

      const response = await result.response;
      const parsedText = response.text();

      // Save the response to test folder
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const testDir = path.join(__dirname, 'test');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }

      fs.writeFileSync(
        path.join(testDir, `ai_parsed_${timestamp}.txt`),
        `Structure Prompt:\n${structurePrompt}\n\nParsed Result:\n${parsedText}`,
        'utf8'
      );

      // Try to parse the response as JSON
      try {
        return JSON.parse(parsedText);
      } catch (e) {
        console.warn('Warning: AI response was not valid JSON, returning raw text');
        return parsedText;
      }

    } catch (error) {
      console.error('Failed to parse text with AI:', error);
      throw error;
    }
  }
}

module.exports = PageSnapshot;

if (require.main === module) {
  const puppeteer = require('puppeteer');
  require('dotenv').config();

  (async () => {
    try {
      const url = 'https://airbnb.com';
      console.log(`Testing PageSnapshot with URL: ${url}`);

      console.log('Launching browser...');
      const browser = await puppeteer.launch({ 
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
      // Test the new AI parsing function
      console.log('\nTesting AI parsing...');
      const structurePrompt = `Please extract the Airbnb listings information in JSON format. 

`;

      const parsedResult = await snapshot.parseTextViewWithAI(structurePrompt);
      console.log('\nAI Parsing Result:', parsedResult);

      console.log('\nSnapshot and parsing complete!');
      console.log('Files saved with timestamp:', result.timestamp);
      console.log('\nDebug files location:', path.join(__dirname, 'test'));

      //await browser.close();
      console.log('\nBrowser closed. Test complete!');

    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  })();
} 