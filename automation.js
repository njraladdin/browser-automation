const puppeteer = require('puppeteer');
require('dotenv').config();
const cheerio = require('cheerio');

let browser = null;
let page = null;
let automationSteps = [];
let lastExecutedStepIndex = -1;

async function generatePuppeteerCode(systemPrompt) {

  
  try {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      throw new Error('GEMINI_API_KEY not found in environment variables');
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-exp-1206:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
          }
        })
      }
    );

    const data = await response.json();
    if (!data.candidates || !data.candidates[0]) {
      throw new Error('Invalid response from Gemini API');
    }

    return data.candidates[0].content.parts[0].text.trim()
      .replace(/```javascript\n?/g, '')
      .replace(/```\n?/g, '');

  } catch (error) {
    console.error('Failed to generate code:', error);
    throw error;
  }
}

async function initBrowser() {
  if (!browser) {
    console.log('Launching browser...');
    browser = await puppeteer.launch({ 
      headless: false,
      defaultViewport: {
        width: 1280,
        height: 800
      }
    });
    page = await browser.newPage();
  }
  return { browser, page };
}

async function addAutomationStep(instructions) {
  try {
    console.log('Generating code for new step...');
    
    // Get previous step's context if available
    let previousContext = null;
    if (lastExecutedStepIndex >= 0) {
      const fs = require('fs');
      const path = require('path');
      const testDir = path.join(__dirname, 'test');
      
      try {
        const previousHtml = fs.readFileSync(
          path.join(testDir, `step_${lastExecutedStepIndex + 1}.html`),
          'utf8'
        );
        const previousMap = JSON.parse(fs.readFileSync(
          path.join(testDir, `step_${lastExecutedStepIndex + 1}_map.json`),
          'utf8'
        ));
        
        previousContext = {
          html: previousHtml,
          pageMap: previousMap
        };
      } catch (err) {
        console.log('No previous step context available');
      }
    }

    // Modify the system prompt to include previous context
    const systemPrompt = `You are a Puppeteer code generator. Generate ONLY the JavaScript code without any explanations, markdown formatting, or code block markers. The code should work with Puppeteer.

Requirements:
- Use modern JavaScript syntax with async/await
- Include error handling with try/catch
- Add clear console.log statements for progress tracking
- Use Puppeteer's API (page.click, page.type, etc.)
- Return ONLY the raw JavaScript code, no markdown, no \`\`\`, no explanations
- DO NOT include browser launch or page creation code
- DO NOT close the browser

${previousContext ? `
Current page context:
HTML: ${previousContext.html}

Page Structure Map:
${JSON.stringify(previousContext.pageMap, null, 2)}
` : ''}

User Instructions: ${instructions}`;

    const code = await generatePuppeteerCode(systemPrompt);
    automationSteps.push({ instructions, code });
    return { success: true, code };
  } catch (error) {
    console.error('Failed to add step:', error);
    return { success: false, error: error.message };
  }
}

async function generatePageMap($) {
  const pageMap = {
    title: $('title').text(),
    forms: [],
    links: [],
    buttons: [],
    inputs: [],
    structure: []
  };

  // Map forms
  $('form').each((i, form) => {
    const formInfo = {
      id: $(form).attr('id') || `form_${i}`,
      action: $(form).attr('action'),
      method: $(form).attr('method'),
      inputs: $(form).find('input, select, textarea').map((_, el) => ({
        type: $(el).attr('type') || el.tagName.toLowerCase(),
        name: $(el).attr('name'),
        id: $(el).attr('id'),
        placeholder: $(el).attr('placeholder')
      })).get()
    };
    pageMap.forms.push(formInfo);
  });

  // Map clickable elements
  $('a').each((i, link) => {
    pageMap.links.push({
      text: $(link).text().trim(),
      href: $(link).attr('href'),
      id: $(link).attr('id'),
      class: $(link).attr('class')
    });
  });

  $('button').each((i, button) => {
    pageMap.buttons.push({
      text: $(button).text().trim(),
      id: $(button).attr('id'),
      type: $(button).attr('type'),
      class: $(button).attr('class')
    });
  });

  // Map input fields
  $('input, select, textarea').each((i, input) => {
    if (!$(input).closest('form').length) { // Only include inputs not already captured in forms
      pageMap.inputs.push({
        type: $(input).attr('type') || input.tagName.toLowerCase(),
        name: $(input).attr('name'),
        id: $(input).attr('id'),
        placeholder: $(input).attr('placeholder')
      });
    }
  });

  // Generate simplified DOM structure
  function generateStructure(element) {
    const $el = $(element);
    const children = $el.children().map((_, child) => generateStructure(child)).get();
    
    return {
      tag: element.tagName.toLowerCase(),
      id: $el.attr('id') || undefined,
      class: $el.attr('class') || undefined,
      type: $el.attr('type') || undefined,
      text: $el.text().trim().substring(0, 100) || undefined,
      children: children.length ? children : undefined
    };
  }

  pageMap.structure = generateStructure($('body')[0]);

  return pageMap;
}

async function cleanupHtml(html) {
  const $ = cheerio.load(html, {
    decodeEntities: true,
    xmlMode: false
  });

  // Remove unwanted elements
  $('script').remove();
  $('style').remove();
  $('link[rel="stylesheet"]').remove();
  $('meta').remove();
  $('svg').remove();
  
  // Define whitelist of allowed attributes
  const allowedAttributes = new Set([
    'class',
    'href',
    'src',
    'id',
    'type',
    'value',
    'title',
    'alt',
    'name',
    'placeholder',
    'role',
    'aria-label',
    'target',
    'rel',
    'for',
    'action',
    'method'
  ]);

  // Clean all elements
  $('*').each((i, el) => {
    if (el.attribs) {
      Object.keys(el.attribs).forEach(attr => {
        // Remove attribute if it's not in the whitelist
        if (!allowedAttributes.has(attr.toLowerCase())) {
          $(el).removeAttr(attr);
        }
      });
    }
  });

  // Get cleaned HTML and normalize whitespace
  let cleanedHtml = $.root().html()
    .replace(/^\s*[\r\n]/gm, '')
    .replace(/\s+$/gm, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n');

  // Generate page map before cleaning
  const pageMap = await generatePageMap($);

  return {
    html: cleanedHtml,
    pageMap: pageMap
  };
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeCurrentSteps() {
  try {
    if (!browser || !page) {
      await initBrowser();
    }

    console.log('Executing automation steps...');
    const startIndex = lastExecutedStepIndex + 1;
    
    for (let i = startIndex; i < automationSteps.length; i++) {
      const step = automationSteps[i];
      console.log(`Executing step ${i + 1}: ${step.instructions}`);
      
      // Create a promise that resolves on navigation
      const navigationPromise = page.waitForNavigation({ 
        waitUntil: 'networkidle0',
        timeout: 30000 
      }).catch(() => {
        // If no navigation occurs, this promise will be rejected, which is fine
        console.log('No navigation occurred during this step');
      });

      // Execute the step
      const stepFunction = new Function('page', `return (async (page) => {
        ${step.code}
      })(page)`);

      await stepFunction(page);
      
      // Wait for any navigation to complete
      await navigationPromise;
      
      // Add a small delay to ensure page is stable
      await delay(1000);
      
      // Take screenshot and convert to base64
      const screenshot = await page.screenshot({ 
        fullPage: false,
        encoding: 'base64'
      });
      automationSteps[i].screenshot = `data:image/png;base64,${screenshot}`;
      
      // Get page source and clean it
      const pageSource = await page.content();
      const { html: cleanedSource, pageMap } = await cleanupHtml(pageSource);
      
      // Ensure test directory exists
      const fs = require('fs');
      const path = require('path');
      const testDir = path.join(__dirname, 'test');
      
      if (!fs.existsSync(testDir)){
        fs.mkdirSync(testDir);
      }
      
      // Save cleaned HTML to file
      fs.writeFileSync(
        path.join(testDir, `step_${i + 1}.html`),
        cleanedSource,
        'utf8'
      );

      // Save page map to JSON file
      fs.writeFileSync(
        path.join(testDir, `step_${i + 1}_map.json`),
        JSON.stringify(pageMap, null, 2),
        'utf8'
      );
      
      lastExecutedStepIndex = i;
    }

    return { 
      success: true, 
      lastExecutedStep: lastExecutedStepIndex,
      steps: automationSteps 
    };
  } catch (error) {
    console.error('Automation failed:', error);
    return { success: false, error: error.message };
  }
}

async function clearSteps() {
  automationSteps = [];
  lastExecutedStepIndex = -1;
  return { success: true };
}

async function resetExecution() {
  lastExecutedStepIndex = -1;
  return { success: true };
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
  return { success: true };
}

module.exports = {
  addAutomationStep,
  executeCurrentSteps,
  clearSteps,
  closeBrowser,
  resetExecution
}; 