const puppeteer = require('puppeteer');
require('dotenv').config();
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { analyzePage } = require('./pageAnalyzer');
const path = require('path');
const fs = require('fs');

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
    model: "gemini-1.5-pro",
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
    
    // Get current page context if browser is running
    let currentContext = null;
    if (browser && page) {
      const pageSource = await page.content();
      currentContext = await analyzePage(pageSource);
    }

    // Create history of previous steps
    const previousSteps = automationSteps.map((step, index) => `
Step ${index + 1}: ${step.instructions}
Code:
${step.code}
`).join('\n');

    const systemPrompt = `You are a Puppeteer code generator. Generate ONLY the executable code without any function declarations or wrappers.

Requirements:
- Use modern JavaScript syntax with async/await
- Always wrap code in try/catch
- Add clear console.log statements for progress tracking
- Use Puppeteer's API (page.click, page.type, etc.)
- Return ONLY the code that will be executed (no functions, no classes)
- For navigation, use page.goto() with proper error handling
Example code:
try {
  console.log('Navigating to URL...');
  await page.goto('https://example.com');
  console.log('Navigation successful');
} catch (error) {
  console.error('Navigation failed:', error);
  throw error;
}
${previousSteps ? `Previous automation steps:
${previousSteps}` : ''}

${currentContext ? `
Available Interactive Elements:
${JSON.stringify(currentContext.interactive, null, 2)}
` : ''}

User Instructions: ${instructions}`;

    // Save prompt for debugging
    await savePromptForDebug(systemPrompt, instructions);

    const code = await generatePuppeteerCode(systemPrompt);
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