const puppeteer = require('puppeteer');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PageSnapshot = require('./PageSnapshot');
const path = require('path');
const fs = require('fs');
const util = require('util');
const fsPromises = require('fs').promises;

class AutomationFlow {
  constructor() {
    this.pageSnapshot = new PageSnapshot();
    this.browser = null;
    this.page = null;
    this.automationSteps = [];
    this.lastExecutedStep = -1;
    this.INITIAL_URL = 'https://anonyig.com/en/';
    this.browserInitializing = null;
    this.statusCallback = null;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async initBrowser() {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page };
    }

    if (this.browserInitializing) {
      return this.browserInitializing;
    }

    this.browserInitializing = (async () => {
      try {
        console.log('Launching browser...');
        this.browser = await puppeteer.launch({ 
          headless: false,
          defaultViewport: {
            width: 1280,
            height: 800
          }
        });
        this.page = await this.browser.newPage();
        
        console.log('Navigating to initial URL...');
        try {
          await this.page.goto(this.INITIAL_URL, { waitUntil: 'networkidle0' });
        } catch (navigationError) {
          throw new Error(`Failed to load initial page: ${navigationError.message}`);
        }
        
        return { browser: this.browser, page: this.page };
      } catch (error) {
        console.error('Failed to launch browser:', error);
        this.browser = null;
        this.page = null;
        throw error;
      } finally {
        this.browserInitializing = null;
      }
    })();

    return this.browserInitializing;
  }

  async savePromptForDebug(prompt, instructions) {
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

  async addAutomationStep(instructions, statusEmitter = () => {}) {
    try {
      statusEmitter({ 
        message: 'Generating code for new step...', 
        type: 'executing', 
        stepIndex: this.automationSteps.length 
      });
      
      if (!this.browser || !this.page) {
        statusEmitter({ 
          message: 'Initializing browser...', 
          type: 'executing', 
          stepIndex: this.automationSteps.length 
        });
        
        try {
          const { browser, page } = await this.initBrowser();
          this.browser = browser;
          this.page = page;
          
          statusEmitter({ 
            message: 'Browser initialized successfully', 
            type: 'info', 
            stepIndex: this.automationSteps.length 
          });
        } catch (browserError) {
          statusEmitter({ 
            message: `Browser initialization failed: ${browserError.message}`, 
            type: 'error', 
            stepIndex: this.automationSteps.length 
          });
          throw browserError;
        }
      }

      statusEmitter({ 
        message: 'Analyzing page and generating automation code...', 
        type: 'info', 
        stepIndex: this.automationSteps.length 
      });

      const snapshot = await this.pageSnapshot.captureSnapshot(this.page);

      const previousSteps = this.automationSteps.map((step, index) => {
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
The parseTextViewWithAI function returns the extracted data directly (either as an object or string).
Your code should wrap the result in a success/extractedData object when using this function.

Example using parseTextViewWithAI:
try {
  console.log('Extracting product data...');
  const extractedData = await parseTextViewWithAI('Extract all product listings with their prices, names, and descriptions');
  console.log('Extracted data:', extractedData);
  return { 
    success: true, 
    extractedData 
  };
} catch (error) {
  console.error('Failed to extract data:', error);
  throw error;
}

IMPORTANT: if you need to do any sorts of extraction of data, you need to use the given function like the example above. you jsut give which data you want in the prop and the function would take care of the rest. do not try to use querySelectorAll or anything like that.
IMPORTANT: When using parseTextViewWithAI, always wrap its result in a success/extractedData object and return it.

For returning extracted data:
Any time you need to return data (whether from parseTextViewWithAI or your own extraction logic), use this format:
return {
  success: true,
  extractedData: data  // can be an object, array, or string
};

Examples:

1. Using parseTextViewWithAI:
try {
  console.log('Extracting product data...');
  const extractedData = await parseTextViewWithAI('Extract all product listings with their prices, names, and descriptions');
  console.log('Extracted data:', extractedData);
  return { 
    success: true, 
    extractedData 
  };
} catch (error) {
  console.error('Failed to extract data:', error);
  throw error;
}

2. Custom data extraction example:
try {
  console.log('Extracting links from page...');
  const links = [];
  await page.evaluate(() => {
    const elements = document.querySelectorAll('__SELECTOR__1');
    elements.forEach(el => {
      links.push({
        href: el.href,
        text: el.textContent
      });
    });
  });
  console.log('Extracted links:', links);
  return {
    success: true,
    extractedData: links
  };
} catch (error) {
  console.error('Failed to extract links:', error);
  throw error;
}

IMPORTANT: 
- If you need to extract or collect any data, always return it in the success/extractedData format
- This applies to both parseTextViewWithAI results and any custom data collection
- The extractedData can be any type of data structure (object, array, string, etc.)

Current Page URL: ${snapshot.url}
-you can use the given interactive elements map where you are provided each element on the page and it's selector so you can interact with them. Use the selectors exactly as they appear in the 'selector' field (in format __SELECTOR__N). DO NOT MODIFY THE SELECTORS. use the interactive map as a guide.

Interactive map:
${JSON.stringify(snapshot.interactive, null, 2)}

Previous automation steps:
${previousSteps ? `Previous automation steps:
${previousSteps}` : ''}
  DO NOT EVER USE SELECTORS THAT ARE NO PROVIDED TO YOU; EVER. only use the selectors provided to you in the interactive map. the selectorsi n the preivous steps examples were replaced and are not accurate, do not use them you fucking retard fucking pig idiot. 

User Instructions: ${instructions}`;

      await this.savePromptForDebug(systemPrompt, instructions);
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not found in environment variables');
      }
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-exp-1206",
        generationConfig: {
          temperature: 0.6,
          topP: 0.95,
          topK: 64,
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
      code = this.pageSnapshot.replaceSelectorsWithOriginals(code);
      
      console.log('Code after selector replacement:', code);
      
      console.log({code});
      
      // After generating the code, immediately execute it
      const stepIndex = this.automationSteps.length;
      this.automationSteps.push({ 
        instructions, 
        code,
        screenshot: null
      });

      // Execute the newly added step
      const executionResult = await this.executeSingleStep(stepIndex, statusEmitter);
      
      if (!executionResult.success) {
        throw new Error(executionResult.error);
      }
      
      return { 
        success: true, 
        code,
        executionResult,
        screenshot: this.automationSteps[stepIndex].screenshot,
        extractedData: this.automationSteps[stepIndex].extractedData
      };
    } catch (error) {
      console.error('Failed to add and execute step:', error);
      statusEmitter({ 
        message: `Failed: ${error.message}`, 
        type: 'error', 
        stepIndex: this.automationSteps.length 
      });
      return { success: false, error: error.message };
    }
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

      const textContent = await this.pageSnapshot.generateTextView(this.page);

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

  async executeCurrentSteps() {
    try {
      console.log('[AutomationFlow] Starting execution of steps');
      console.log('[AutomationFlow] Last executed step:', this.lastExecutedStep);
      
      const startIndex = (typeof this.lastExecutedStep === 'number' ? this.lastExecutedStep : -1) + 1;
      console.log('[AutomationFlow] Starting from index:', startIndex);
      
      for (let i = startIndex; i < this.automationSteps.length; i++) {
        console.log(`[AutomationFlow] Executing step ${i}:`);
        
        const statusEmitter = (status) => {
          if (this.statusCallback) {
            this.statusCallback(status);
          }
        };

        // Emit executing status
        statusEmitter({
          message: 'Executing step...',
          type: 'executing',
          stepIndex: i
        });

        const result = await this.executeSingleStep(i, statusEmitter);
        if (!result.success) {
          statusEmitter({
            message: result.error,
            type: 'error',
            stepIndex: i
          });
          throw new Error(result.error);
        }

        // Update lastExecutedStep after successful execution
        this.lastExecutedStep = i;

        // Emit success status
        statusEmitter({
          message: 'Step completed successfully',
          type: 'success',
          stepIndex: i
        });

        // Small delay between steps
        await this.delay(500);
      }

      const updatedSteps = this.automationSteps.map(step => ({
        instructions: step.instructions,
        code: step.code,
        extractedData: step.extractedData,
        screenshot: step.screenshot
      }));

      console.log('[AutomationFlow] Execution completed. Last executed step:', this.lastExecutedStep);

      return { 
        success: true, 
        lastExecutedStep: this.lastExecutedStep,
        steps: updatedSteps
      };
    } catch (error) {
      console.error('[AutomationFlow] Execution failed:', error);
      return { success: false, error: error.message };
    }
  }

  async resetExecution() {
    try {
      this.lastExecutedStep = -1;
      
      // Clear execution data from steps
      this.automationSteps = this.automationSteps.map(step => ({
        instructions: step.instructions,
        code: step.code,
        screenshot: null,
        extractedData: null,
        status: null
      }));
      
      // Reset browser state if needed
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
      
      return { 
        success: true, 
        steps: this.automationSteps 
      };
    } catch (error) {
      console.error('Failed to reset execution:', error);
      return { success: false, error: error.message };
    }
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    return { success: true };
  }

  async executeSingleStep(stepIndex, statusEmitter = () => {}) {
    try {
      // Emit starting status
      statusEmitter({ 
        message: 'Starting step execution...', 
        type: 'executing', 
        stepIndex 
      });

      if (!this.browser || !this.page) {
        statusEmitter({ message: 'Initializing browser...', type: 'info', stepIndex });
        try {
          await this.initBrowser();
        } catch (browserError) {
          statusEmitter({ 
            message: `Browser initialization failed: ${browserError.message}`, 
            type: 'error', 
            stepIndex 
          });
          throw browserError;
        }
      }

      if (stepIndex < 0 || stepIndex >= this.automationSteps.length) {
        throw new Error('Invalid step index');
      }

      const step = this.automationSteps[stepIndex];
      this.lastExecutedStep = stepIndex;
      
      statusEmitter({ 
        message: 'Executing automation code...', 
        type: 'executing', 
        stepIndex 
      });

      const stepFunction = new Function(
        'page', 
        'parseTextViewWithAI',
        `return (async (page, parseTextViewWithAI) => {
          ${step.code}
        })(page, parseTextViewWithAI)`
      );

      try {
        const result = await stepFunction(this.page, this.parseTextViewWithAI.bind(this));
        // If the result contains extractedData, store it in the step
        if (result && result.success && result.extractedData) {
          this.automationSteps[stepIndex].extractedData = result.extractedData;
        }
        statusEmitter({ 
          message: 'Step executed successfully', 
          type: 'success', 
          stepIndex 
        });
      } catch (executionError) {
        statusEmitter({ 
          message: `Failed: ${executionError.message}`, 
          type: 'error', 
          stepIndex 
        });
        throw executionError;
      }

      await this.delay(1000);

      try {
        statusEmitter({ message: 'Capturing screenshot...', type: 'info', stepIndex });
        const screenshot = await this.page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 80
        });
        this.automationSteps[stepIndex].screenshot = `data:image/jpeg;base64,${screenshot}`;
      } catch (screenshotError) {
        console.error('Failed to capture screenshot:', screenshotError);
      }

      const updatedSteps = this.automationSteps.map(step => ({
        instructions: step.instructions,
        code: step.code,
        extractedData: step.extractedData,
        screenshot: step.screenshot
      }));

      return { 
        success: true, 
        lastExecutedStep: this.lastExecutedStep,
        steps: updatedSteps
      };
    } catch (error) {
      console.error('Step execution failed:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = AutomationFlow; 