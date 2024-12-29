const puppeteer = require('puppeteer');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PageSnapshot = require('./PageSnapshot');
const path = require('path');
const fs = require('fs');

// Create a single instance of PageSnapshot to reuse
const pageSnapshot = new PageSnapshot();

let browser = null;
let page = null;
let automationSteps = [];
let lastExecutedStepIndex = -1;
let genAI = null;
let model = null;

// Initialize browser immediately
(async () => {
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({ 
      headless: false,
      defaultViewport: {
        width: 1280,
        height: 800
      }
    });
    page = await browser.newPage();
    console.log('Browser ready for use');
  } catch (error) {
    console.error('Failed to launch browser:', error);
  }
})();

// Initialize Gemini API (add this right after browser initialization)
try {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment variables');
  }
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp",
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
    }
  });
  console.log('Gemini API initialized successfully');
} catch (error) {
  console.error('Failed to initialize Gemini API:', error);
}

async function generatePuppeteerCode(systemPrompt) {
  try {
    if (!model) {
      throw new Error('Gemini API not initialized');
    }

    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    const text = response.text();
    
    if (!text) {
      throw new Error('Empty response from Gemini API');
    }

    return text.trim()
      .replace(/```javascript\n?/g, '')
      .replace(/```\n?/g, '');

  } catch (error) {
    console.error('Gemini API error:', error);
    throw new Error(`Failed to generate code: ${error.message}`);
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

async function savePromptForDebug(prompt, instructions) {
  const testDir = path.join(__dirname, 'test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(
    path.join(testDir, `prompt_${timestamp}.txt`),
    `Instructions: ${instructions}\n\nFull Prompt:\n${prompt}`,
    'utf8'
  );
}

async function addAutomationStep(instructions) {
  try {
    console.log('Generating code for new step...');
    
    if (!browser) {
      throw new Error('Browser is not initialized. Cannot proceed with automation.');
    }

    if (!page) {
      page = await browser.newPage();
      console.log('Created new browser page');
    }

    const snapshot = await pageSnapshot.captureSnapshot(page);

    const previousSteps = automationSteps.map((step, index) => `
Step ${index + 1}: ${step.instructions}
Code:
${step.code}
`).join('\n');

    const systemPrompt = `You are a Puppeteer code generator. Generate ONLY the executable code without any function declarations or wrappers.

Requirements:
- Use modern JavaScript syntax with async/await
- Always wrap code in try/catch
- Add clear console.log statements
- Return ONLY executable code
- For elements with shadowPath:
  1. Use page.evaluate() to focus the element
  2. For typing, use page.keyboard.type() after focusing
- For regular elements: use normal page methods with minimal selectors

Example using element with shadowPath:
try {
  console.log('Typing in input field');
  await page.evaluate(() => {
    const input = document.querySelector('reddit-search-large')
      ?.shadowRoot?.querySelector('faceplate-search-input')
      ?.shadowRoot?.querySelector('input');
    input.focus();
  });
  await page.keyboard.type('text', {delay: 50});
} catch (error) {
  console.error('Failed to type text:', error);
  throw error;
}

Example using regular element:
try {
  console.log('Clicking button');
  await page.click('button[type="submit"]');
} catch (error) {
  console.error('Failed to click button:', error);
  throw error;
}

Current Page URL: ${snapshot.url}
-you can use the given interactive elements map where you are provided each element on the page and it's selector so you can interact with them. you are only allowed to use the given selectors for the elements on the page. DO NOT USE ANY OTHER SELECTORS. use the interactive map as a guide.
Available Interactive Elements:
${JSON.stringify(snapshot.interactive, null, 2)}

${previousSteps ? `Previous automation steps:
${previousSteps}` : ''}

User Instructions: ${instructions}`;

    await savePromptForDebug(systemPrompt, instructions);

    const code = await generatePuppeteerCode(systemPrompt);
    console.log(code);
    
    automationSteps.push({ instructions, code });
    
    return { success: true, code };
  } catch (error) {
    console.error('Failed to add step:', error);
    return { success: false, error: error.message };
  }
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
      
      // Execute the step
      const stepFunction = new Function('page', `return (async (page) => {
        ${step.code}
      })(page)`);

      await stepFunction(page);
      await delay(1000); // Small delay for stability
      
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