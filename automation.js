const puppeteer = require('puppeteer');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PageSnapshot = require('./PageSnapshot');
const path = require('path');
const fs = require('fs');
const util = require('util');
const fsPromises = require('fs').promises;

// Create a single instance of PageSnapshot to reuse
const pageSnapshot = new PageSnapshot();

let browser = null;
let page = null;
let automationSteps = [];
let lastExecutedStepIndex = -1;


const INITIAL_URL = 'https://airbnb.com/';


async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize browser immediately
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
    await page.goto(INITIAL_URL);
  }
  return { browser, page };
}

// Add immediate browser initialization
initBrowser().catch(error => {
  console.error('Failed to launch browser:', error);
});

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

    const previousSteps = automationSteps.map((step, index) => {
      let extractedDataSummary = '';
      if (step.extractedData) {
        const data = step.extractedData;
        if (data?.items) {
          const items = data.items;
          extractedDataSummary = `
Extracted Data Summary:
- Total items: ${items.length}
- First item: ${JSON.stringify(items[0])}
- Last item: ${JSON.stringify(items[items.length - 1])}`;
        }
      }

      return `
Step ${index + 1}: ${step.instructions}
Code:
${step.code}${extractedDataSummary}`;
    }).join('\n');

    const systemPrompt = `You are a Puppeteer code generator. Generate ONLY the executable code without any function declarations or wrappers.

Requirements:
- Use modern JavaScript syntax with async/await
- Always wrap code in try/catch
- Add clear console.log statements
- Return ONLY executable code
- Use the selectors provided in the interactive map exactly as they appear (in format __SELECTOR__N), and if ther's an ID then you can use it as well
- For elements with shadowPath:
  1. Use page.evaluate() to focus the element
  2. For typing, use page.keyboard.type() after focusing
  use promise for waiting instead of waitForTimeout
- For regular elements: use normal page methods with minimal selectors
- keep in mind that the code would probably be ran again, but not with the exact elements content or elements number (like listings etc.), so use selectors smartly 

Example using element with shadowPath:
try {
  console.log('Typing in input field');
  await page.evaluate(() => {
    const input = document.querySelector('__SELECTOR__1')
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
  await page.click('__SELECTOR__2');
} catch (error) {
  console.error('Failed to click button:', error);
  throw error;
}

For data extraction tasks:
You can use: await parseTextViewWithAI(structurePrompt)
where structurePrompt is a string explaining what data to extract from the page.
Example:
try {
  console.log('Extracting product data...');
  const data = await parseTextViewWithAI('Extract all product listings with their prices, names, and descriptions');
  console.log('Extracted data:', data);
} catch (error) {
  console.error('Failed to extract data:', error);
  throw error;
}
IMPORTANT: if you need to do any sorts of extraction of data, you need to use the given function like the example above. you jsut give which data you want in the prop and the function would take care of the rest. do not try to use querySelectorAll or anything like that.
Current Page URL: ${snapshot.url}
-you can use the given interactive elements map where you are provided each element on the page and it's selector so you can interact with them. Use the selectors exactly as they appear in the 'selector' field (in format __SELECTOR__N). DO NOT MODIFY THE SELECTORS. use the interactive map as a guide.

Interactive map:
${JSON.stringify(snapshot.interactive, null, 2)}

Previous automation steps:
${previousSteps ? `Previous automation steps:
${previousSteps}` : ''}

User Instructions: ${instructions}`;

    await savePromptForDebug(systemPrompt, instructions);
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment variables');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
      }
    });
    
    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    let code = response.text().trim()
      .replace(/```javascript\n?/g, '')
      .replace(/```\n?/g, '');
    
    console.log('Code before selector replacement:', code);
    
    // Replace short selectors with original selectors
    code = pageSnapshot.replaceSelectorsWithOriginals(code);
    
    console.log('Code after selector replacement:', code);
    
    console.log({code});
    
    automationSteps.push({ 
      instructions, 
      code,
      screenshot: null
    });
    
    return { success: true, code };
  } catch (error) {
    console.error('Failed to add step:', error);
    return { success: false, error: error.message };
  }
}
async function parseTextViewWithAI(structurePrompt) {
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

    const textContent = pageSnapshot.generateTextView();

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

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: systemPrompt }]}]
    });

    const response = await result.response;
    const parsedText = response.text();

    // Save debug file
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

    // Parse the response and update the current step
    try {
      const extractedData = JSON.parse(parsedText);
      if (lastExecutedStepIndex < automationSteps.length) {
        automationSteps[lastExecutedStepIndex].extractedData = extractedData;
      }
      return extractedData;
    } catch (e) {
      console.warn('Warning: AI response was not valid JSON, returning raw text');
      if (lastExecutedStepIndex < automationSteps.length) {
        automationSteps[lastExecutedStepIndex].extractedData = parsedText;
      }
      return parsedText;
    }

  } catch (error) {
    console.error('Failed to parse text with AI:', error);
    throw error;
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
      
      lastExecutedStepIndex = i;
      
      const stepFunction = new Function(
        'page', 
        'parseTextViewWithAI',
        `return (async (page, parseTextViewWithAI) => {
          ${step.code}
        })(page, parseTextViewWithAI)`
      );

      await stepFunction(page, parseTextViewWithAI);
      await delay(1000);

      // Take screenshot after step execution
      try {
        const screenshot = await page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 80 // Adjust quality to balance size and quality
        });
        
        // Add screenshot to the step data
        automationSteps[i].screenshot = `data:image/jpeg;base64,${screenshot}`;
      } catch (screenshotError) {
        console.error('Failed to capture screenshot:', screenshotError);
        automationSteps[i].screenshot = null;
      }
    }

    const updatedSteps = automationSteps.map(step => ({
      instructions: step.instructions,
      code: step.code,
      extractedData: step.extractedData,
      screenshot: step.screenshot
    }));

    return { 
      success: true, 
      lastExecutedStep: lastExecutedStepIndex,
      steps: updatedSteps
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