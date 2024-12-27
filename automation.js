const puppeteer = require('puppeteer');
require('dotenv').config();

let browser = null;
let page = null;
let automationSteps = [];
let lastExecutedStepIndex = -1;

async function generatePuppeteerCode(instructions) {
  const systemPrompt = `You are a Puppeteer code generator. Generate ONLY the JavaScript code without any explanations, markdown formatting, or code block markers. The code should work with Puppeteer.

Requirements:
- Use modern JavaScript syntax with async/await
- Include error handling with try/catch
- Add clear console.log statements for progress tracking
- Use Puppeteer's API (page.click, page.type, etc.)
- Return ONLY the raw JavaScript code, no markdown, no \`\`\`, no explanations
- DO NOT include browser launch or page creation code
- DO NOT close the browser

Example format of generated code:
try {
  await page.goto('https://example.com');
  await page.click('#someButton');
  // etc...
} catch (error) {
  console.error('Error:', error);
}

User Instructions: ${instructions}`;

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
      defaultViewport: null
    });
    page = await browser.newPage();
  }
  return { browser, page };
}

async function addAutomationStep(instructions) {
  try {
    console.log('Generating code for new step...');
    const code = await generatePuppeteerCode(instructions);
    automationSteps.push({ instructions, code });
    return { success: true, code };
  } catch (error) {
    console.error('Failed to add step:', error);
    return { success: false, error: error.message };
  }
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
      
      const stepFunction = new Function('page', `return (async (page) => {
        ${step.code}
      })(page)`);

      await stepFunction(page);
      lastExecutedStepIndex = i;
    }

    return { success: true, lastExecutedStep: lastExecutedStepIndex };
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