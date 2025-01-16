const puppeteer = require('puppeteer');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PageSnapshot = require('./PageSnapshot');
const path = require('path');
const fs = require('fs');
const clc = require('cli-color');

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
    this.aiSelectorResults = [];
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
        console.log(clc.cyan('▶ Launching browser...'));
        this.browser = await puppeteer.launch({ 
          headless: false,
          defaultViewport: {
            width: 1280,
            height: 800
          }
        });
        this.page = await this.browser.newPage();
        
        console.log(clc.cyan('▶ Navigating to initial URL...'));
        try {
          await this.page.goto(this.INITIAL_URL, { waitUntil: 'networkidle0' });
          console.log(clc.green('✓ Page loaded successfully'));
        } catch (navigationError) {
          throw new Error(`Failed to load initial page: ${navigationError.message}`);
        }
        
        return { browser: this.browser, page: this.page };
      } catch (error) {
        console.log(clc.red('✗ Browser initialization failed:'), error.message);
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
      console.log(clc.cyan('\n▶ Adding new automation step:'), instructions);
      
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
- write code in SLOW MODE, meaning impelment generous delays and waiting for elements to load, so that it's safer and also the user more easily to follow the execution when running
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
The extractStructuredContentUsingAI function returns the extracted data directly (either as an object or string).
Your code should wrap the result in a success/extractedData object when using this function.

Example using extractStructuredContentUsingAI:
try {
  console.log('Extracting product data...');
  const extractedData = await extractStructuredContentUsingAI('Extract all product listings with their prices, names, and descriptions');
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
IMPORTANT: When using extractStructuredContentUsingAI, always wrap its result in a success/extractedData object and return it.

For returning extracted data:
Any time you need to return data (whether from extractStructuredContentUsingAI or your own extraction logic), use this format:
return {
  success: true,
  extractedData: data  // can be an object, array, or string
};

Examples:

1. Using extractStructuredContentUsingAI:
try {
  console.log('Extracting product data...');
  const extractedData = await extractStructuredContentUsingAI('Extract all product listings with their prices, names, and descriptions');
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
- This applies to both extractStructuredContentUsingAI results and any custom data collection
- The extractedData can be any type of data structure (object, array, string, etc.)

For dynamic content (like modals, popups, or any new elements that appear after user actions):

WHY USE findSelectorForDynamicElementUsingAI()?
- The interactive map only contains selectors for elements that existed when the page was first loaded
- When new content appears dynamically (like modals), these elements aren't in our original map
- The function analyzes recent DOM changes to find and generate reliable selectors for these new elements
- It uses AI to understand your description and find the right element in the recent changes
- Without this function, you'd have no reliable way to get selectors for dynamic content

Use findSelectorForDynamicElementUsingAI() to get selectors for elements that appear dynamically (like in modals, popups, etc). Here's how to use it:

Example using dynamic content with findSelectorForDynamicElementUsingAI():
try {
  // Example 1: Handling a dropdown menu
  console.log('Opening dropdown menu...');
  await page.click('.menu-trigger');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const menuItemSelector = await findSelectorForDynamicElementUsingAI(
    'the actual clickable link/button element (not its container) in the dropdown that says "Settings"'
  );
  await page.click(menuItemSelector);

  // Example 2: Handling a notification
  const notificationTextSelector = await findSelectorForDynamicElementUsingAI(
    'the actual text element (p or span tag) containing the notification message'
  );
  const message = await page.$eval(notificationTextSelector, el => el.textContent);
console.log(message)
  // Example 3: Handling a search autocomplete
  await page.type('.search-input', 'test');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const suggestionSelector = await findSelectorForDynamicElementUsingAI(
    'the actual clickable suggestion element (li or div tag) from the autocomplete dropdown'
  );
  await page.click(suggestionSelector);

  return {
    success: true,
    extractedData: {
      notification: message,
      // other data...
    }
  };
} catch (error) {
  console.error('Failed:', error);
  throw error;
}
  Example of INCORRECT usage (DON'T DO THIS):
❌ const mediaType = await findSelectorForDynamicElementUsingAI('determine if video or image');  // Wrong! Function only returns selectors
❌ const sourceUrl = await findSelectorForDynamicElementUsingAI('get the source URL');  // Wrong! Function only returns selectors

Instead, do this:
✅ const mediaSelector = await findSelectorForDynamicElementUsingAI('the video or img element in the modal');
✅ const mediaType = await page.$eval(mediaSelector, el => el.tagName.toLowerCase());
✅ const sourceUrl = await page.$eval(mediaSelector, el => el.src);

IMPORTANT: 
- Use findSelectorForDynamicElementUsingAI() for ANY elements that appear after page changes (modals, popups, dynamic content)
- This function ONLY returns a CSS selector string. It does NOT return data, types, or any other information
- Always add a 2-second delay after the action that causes DOM changes
- The function returns a selector you can use with normal page methods (click, $eval, etc)
- For elements that were present when the page loaded, use the selectors from the interactive map instead



For handling unpredictable outcomes after actions, use generateNextActionCodeUsingAI():

Example usage:
try {
  console.log('Clicking submit button...');
  await page.click('#submit-button');
  
  // Wait for DOM changes to settle
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const success = await generateNextActionCodeUsingAI(
    'Check if: 1) Success message appeared 2) Error message shown 3) Form validation failed'
  );

  if (!success) {
    throw new Error('Action failed');
  }
} catch (error) {
  console.error('Failed:', error);
  throw error;
}

Don't use this when:
- You just need to wait for an element (use waitForSelector instead)
- You need to extract data (use extractStructuredContentUsingAI instead)
- You need to find a dynamic element (use findSelectorForDynamicElementUsingAI instead)


Current Page URL: ${snapshot.url}
-you can use the given interactive elements map where you are provided each element on the page and it's selector so you can interact with them. Use the selectors exactly as they appear in the 'selector' field (in format __SELECTOR__N). DO NOT MODIFY THE SELECTORS. use the interactive map as a guide.

Interactive map:
${JSON.stringify(snapshot.interactive, null, 2)}



Previous automation steps:
${previousSteps ? `Previous automation steps:
${previousSteps}` : ''}
  DO NOT EVER USE SELECTORS THAT ARE NO PROVIDED TO YOU; EVER. only use the selectors provided to you in the interactive map. the selectorsi n the preivous steps examples were replaced and are not accurate, do not use them you fucking retard fucking pig idiot. 

User Instructions: ${instructions}`;
/*page html:
${snapshot.html} */
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
      
      
      // After generating the code, immediately execute it
      console.log(clc.cyan('▶ Generated code length:'), code.length);
      console.log(clc.cyan('▶ Executing generated code...'));

      const stepIndex = this.automationSteps.length;
      this.automationSteps.push({ 
        instructions, 
        code,
        screenshot: null
      });

      const executionResult = await this.executeSingleStep(stepIndex, statusEmitter);
      
      if (!executionResult.success) {
        console.log(clc.red('✗ Step execution failed:'), executionResult.error);
        throw new Error(executionResult.error);
      }

      // After successful execution, if we have AI selectors, replace them with concrete ones
      if (this.aiSelectorResults.length > 0) {
        statusEmitter({ 
          message: 'Replacing AI selectors with concrete values...', 
          type: 'info', 
          stepIndex 
        });
        
        const updatedCode = await this.replaceAISelectorsWithConcreteSelectors(
          code, 
          this.aiSelectorResults
        );
        
        // Update the step's code with concrete selectors
        this.automationSteps[stepIndex].code = updatedCode;
        code = updatedCode; // Update the code that will be returned
        
        statusEmitter({ 
          message: 'Successfully replaced AI selectors with concrete values', 
          type: 'success', 
          stepIndex 
        });
      }

      console.log(clc.green('✓ Step added and executed successfully'));
      return { 
        success: true, 
        code, // This will now be the concrete version if AI selectors were used
        executionResult,
        screenshot: this.automationSteps[stepIndex].screenshot,
        extractedData: this.automationSteps[stepIndex].extractedData
      };
    } catch (error) {
      console.log(clc.red('✗ Failed to add automation step:'), error.message);
      statusEmitter({ 
        message: `Failed: ${error.message}`, 
        type: 'error', 
        stepIndex: this.automationSteps.length 
      });
      return { success: false, error: error.message };
    }
  }

  async extractStructuredContentUsingAI(structurePrompt) {
    try {
      console.log(clc.cyan('▶ Starting AI content extraction...'));
      
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

      // Get the content map instead of text view
      const contentMap = this.pageSnapshot.getContentMap();

      const systemPrompt = `You are an AI assistant that parses webpage content and extracts structured information.

      Input Content Map from Webpage:
      ${JSON.stringify(contentMap, null, 2)}

      The content map contains structured data where:
      - type: can be 'text', 'media', or 'structure'
      - content: the actual text content (for text type)
      - mediaType: 'image' or 'video' (for media type)
      - src: source URL (for media type)
      - tag: HTML tag name
      - selector: unique selector for the element
      - role: ARIA role if present
      - aria-label: accessibility label if present

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
      - We need to extract as much relevant data as possible
      - Use the structured content map to accurately identify and extract information`;

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
        `Structure Prompt:\n${structurePrompt}\n\nContent Map:\n${JSON.stringify(contentMap, null, 2)}\n\nParsed Result:\n${parsedText}`,
        'utf8'
      );

      try {
        const result = JSON.parse(parsedText);
        console.log(clc.green('✓ Successfully parsed content with AI'));
        return result;
      } catch (e) {
        console.log(clc.yellow('⚠ AI response was not valid JSON, returning raw text'));
        return parsedText;
      }

    } catch (error) {
      console.log(clc.red('✗ Content parsing failed:'), error.message);
      throw error;
    }
  }

  async executeCurrentSteps() {
    try {
      console.log(clc.cyan('\n▶ Starting execution of all steps'));
      console.log(clc.cyan(`▶ Total steps: ${this.automationSteps.length}, Starting from: ${this.lastExecutedStep + 1}`));
      
      const startIndex = (typeof this.lastExecutedStep === 'number' ? this.lastExecutedStep : -1) + 1;
      console.log('[AutomationFlow] Starting from index:', startIndex);
      
      for (let i = startIndex; i < this.automationSteps.length; i++) {
        console.log(clc.cyan(`\n▶ Executing step ${i + 1}/${this.automationSteps.length}:`), this.automationSteps[i].instructions);
        
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
          console.log(clc.red('✗ Step execution failed:'), result.error);
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

      console.log(clc.green('\n✓ All steps executed successfully'));
      console.log('[AutomationFlow] Execution completed. Last executed step:', this.lastExecutedStep);

      return { 
        success: true, 
        lastExecutedStep: this.lastExecutedStep,
        steps: this.automationSteps
      };
    } catch (error) {
      console.log(clc.red('✗ Steps execution failed:'), error.message);
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
      console.log(clc.cyan(`\n▶ Executing step ${stepIndex + 1}`));
      
      // Reset AI selector results at the start
      this.aiSelectorResults = [];
      
      // Emit starting status
      statusEmitter({ 
        message: 'Starting step execution...', 
        type: 'executing', 
        stepIndex 
      });
      if (!this.browser || !this.page) {
        console.log(clc.cyan('▶ Browser not initialized, initializing...'));
        try {
          await this.initBrowser();
        } catch (browserError) {
          statusEmitter({ 
            message: `Browser initialization failed: ${browserError.message}`, 
            type: 'error', 
            stepIndex 
          });
          console.log(clc.red('✗ Browser initialization failed:'), browserError.message);
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

      // Execute the step
      const stepFunction = new Function(
        'page', 
        'extractStructuredContentUsingAI',
        'findSelectorForDynamicElementUsingAI',
        `return (async (page, extractStructuredContentUsingAI, findSelectorForDynamicElementUsingAI) => {
          ${step.code}
        })(page, extractStructuredContentUsingAI, findSelectorForDynamicElementUsingAI)`
      );

      try {
        const result = await stepFunction(
          this.page, 
          this.extractStructuredContentUsingAI.bind(this),
          this.findSelectorForDynamicElementUsingAI.bind(this)
        );

        // Store extracted data if present
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
        console.log(clc.cyan('▶ Capturing step screenshot...'));
        const screenshot = await this.page.screenshot({
          encoding: 'base64',
          type: 'jpeg',
          quality: 80
        });
        this.automationSteps[stepIndex].screenshot = `data:image/jpeg;base64,${screenshot}`;
        console.log(clc.green('✓ Screenshot captured'));
      } catch (screenshotError) {
        console.log(clc.yellow('⚠ Failed to capture screenshot:'), screenshotError.message);
      }

      console.log('\nRETURNING - Final step code:', this.automationSteps[stepIndex].code);
      
      return { 
        success: true, 
        lastExecutedStep: this.lastExecutedStep,
        steps: this.automationSteps
      };
    } catch (error) {
      console.log(clc.red('✗ Step execution failed:'), error.message);
      return { success: false, error: error.message };
    }
  }

  async findSelectorForDynamicElementUsingAI(description) {
    try {
      console.log(clc.cyan('\n▶ Finding selector for:'), description);

      const latestChanges = this.pageSnapshot.getLatestDOMChanges();
      console.log(clc.cyan(`▶ Found ${latestChanges.length} DOM changes`));

      if (!latestChanges || latestChanges.length === 0) {
        console.log(clc.red('✗ No DOM changes tracked'));
        throw new Error('No DOM changes tracked');
      }

      // Log a summary of the changes
      console.log('\nLatest Changes Summary:');
      latestChanges.forEach((change, index) => {
        console.log(`\nChange ${index + 1}:`);
        console.log('- Type:', change.type);
        console.log('- Selector Path:', change.selectorPath);
        if (change.addedNodes?.length) {
          console.log('- Added Nodes:', change.addedNodes.length);
        }
        if (change.removedNodes?.length) {
          console.log('- Removed Nodes:', change.removedNodes.length);
        }
      });

      const systemPrompt = `You are an AI assistant that finds DOM elements in newly added content.

Latest DOM Changes:
${JSON.stringify(latestChanges, null, 2)}

Description of element to find: "${description}"

Instructions:
1. Look through the HTML in the latest DOM changes
2. Find the element that best matches the description
3. Return the COMPLETE selector path:
   - Start with the container selector from the DOM changes
   - Continue down to the specific element (img, video, button, etc.)
   - For media elements, go all the way to the actual media tag (img, video, source)
4. Focus on elements in addedNodes, containerHTML, or elementHTML
5. Prefer IDs and unique class combinations
6. Make sure the selector is specific enough to target the exact element

Example good selectors:
- For an image: "#app > div.modal > div.media-modal__media > div.media-modal-item > div.media-modal-item__wrapper > img.media-modal-item__content"
- For a video: "#app > div.modal > div.media-modal__media > div.media-modal-item > video.video-player > source"
- For a button: "#app > div.modal > div.media-modal__media > button.media-modal__button--close"

Return ONLY the complete selector string. No explanation, no JSON, just the complete selector path to that specific element in the description.`;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.log('❌ Error: Missing API key');
        throw new Error('GEMINI_API_KEY not found in environment variables');
      }

      console.log('\nQuerying AI for selector...');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-exp",
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 256,
        }
      });

      const result = await model.generateContent(systemPrompt);
      const selector = result.response.text().trim();
      console.log('AI Response (selector):', selector);

      // Store the result
      this.aiSelectorResults.push({
        description,
        selector,
        timestamp: Date.now()
      });

      console.log('=== Selector Search Complete ===\n');
      return selector;
    } catch (error) {
      console.log(clc.red('✗ Failed to find selector:'), error.message);
      throw error;
    }
  }

  async validateSelector(selector) {
    try {
      // Actually try to find the element using the selector
      const element = await this.page.$(selector);
      return element !== null;
    } catch (error) {
      console.log(clc.yellow('⚠ Selector validation failed:'), error.message);
      return false;
    }
  }

  async replaceAISelectorsWithConcreteSelectors(code, selectorResults) {
    console.log({selectorResults})
    try {
      console.log(clc.cyan('▶ Generating concrete selectors for code...'));
      
      const systemPrompt = `You are an AI assistant that replaces dynamic selector lookups with concrete selectors.

Original Code:
${code}

Selector Results (from findSelectorForDynamicElementUsingAI calls):
${JSON.stringify(selectorResults, null, 2)}

Instructions:
1. Analyze the code and the selector results
2. Replace each findSelectorForDynamicElementUsingAI call with its concrete selector
3. If you notice patterns in selectors, optimize the code accordingly. make sure the css selector is valid.
4. Preserve all other functionality and error handling
5. Return ONLY the updated code, no explanations

Important:
- Keep all console.log statements
- Maintain existing error handling
- Preserve timing/delays
- Only replace the findSelectorForDynamicElementUsingAI calls`;

      const apiKey = process.env.GEMINI_API_KEY;
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-8b",
        generationConfig: {
          temperature: 0.2,
          topP: 0.95,
          maxOutputTokens: 8192,
        }
      });

      const result = await model.generateContent(systemPrompt);
      const updatedCode = result.response.text().trim()
      .replace(/```javascript\n?/g, '')
      .replace(/```\n?/g, '');

      console.log(clc.green('✓ Successfully generated concrete code'));
      return updatedCode;
    } catch (error) {
      console.log(clc.red('✗ Failed to generate concrete code:'), error.message);
      throw error;
    }
  }

  async generateNextActionCodeUsingAI(description) {
    try {
      console.log(clc.cyan('\n▶ Generating next action code for:'), description);

      const latestChanges = this.pageSnapshot.getLatestDOMChanges();
      console.log(clc.cyan(`▶ Found ${latestChanges.length} DOM changes`));

      if (!latestChanges || latestChanges.length === 0) {
        throw new Error('No DOM changes tracked');
      }

      // Get current page content map for context
      const contentMap = this.pageSnapshot.getContentMap();

      const systemPrompt = `You are an AI assistant that generates Puppeteer code for handling unpredictable next actions.

Latest DOM Changes (showing what changed after the action):
${JSON.stringify(latestChanges, null, 2)}

Current Page Content Map (showing current state):
${JSON.stringify(contentMap, null, 2)}

Description of next action to handle: "${description}"

Instructions:
1. Analyze the DOM changes to understand what happened after the action
2. Generate code that:
   - Detects which outcome occurred using the provided DOM changes
   - Handles each possible outcome appropriately
   - Uses proper error handling and logging
3. Use standard Puppeteer methods:
   - page.waitForSelector()
   - page.evaluate()
   - page.$()
   - page.$$()
   - page.$eval()
   - page.click()
   - etc.
4. Always include proper error handling and logging
5. Return only a boolean indicating success or failure

Example Response Format:
try {
  console.log('Checking for possible outcomes...');
  
  // Check for success message
  const hasSuccess = await page.evaluate(() => {
    const successEl = document.querySelector('.success-message, .alert-success');
    return successEl !== null && successEl.textContent.includes('Successfully');
  });

  if (hasSuccess) {
    console.log('Success outcome detected');
    return true;
  }

  // Check for validation errors
  const hasErrors = await page.evaluate(() => {
    const errorEl = document.querySelector('.error-message, .validation-error');
    return errorEl !== null;
  });

  if (hasErrors) {
    console.log('Validation errors detected');
    return false;
  }

  // Check for verification required
  const needsVerification = await page.evaluate(() => {
    const verifyEl = document.querySelector('.verify-prompt');
    return verifyEl !== null;
  });

  if (needsVerification) {
    console.log('Verification required');
    return false;
  }

  return true;  // Default success case

} catch (error) {
  console.error('Failed to handle outcome:', error);
  return false;
}

Return ONLY the executable code block. No explanations or wrapper functions.`;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not found in environment variables');
      }

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-exp",
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
        }
      });

      const result = await model.generateContent(systemPrompt);
      const code = result.response.text().trim()
        .replace(/```javascript\n?/g, '')
        .replace(/```\n?/g, '');

      // Execute the generated code
      console.log(clc.cyan('▶ Executing generated next action code...'));
      
      const stepFunction = new Function(
        'page',
        'findSelectorForDynamicElementUsingAI',
        'extractStructuredContentUsingAI',
        `return (async (page, findSelectorForDynamicElementUsingAI, extractStructuredContentUsingAI) => {
          ${code}
        })(page, findSelectorForDynamicElementUsingAI, extractStructuredContentUsingAI)`
      );

      const executionResult = await stepFunction(
        this.page,
        this.findSelectorForDynamicElementUsingAI.bind(this),
        this.extractStructuredContentUsingAI.bind(this)
      );

      console.log(clc.green('✓ Next action code executed successfully'));
      console.log('Execution result:', executionResult);

      // Save debug information
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const testDir = path.join(__dirname, 'test');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }

      fs.writeFileSync(
        path.join(testDir, `next_action_${timestamp}.txt`),
        `Description: ${description}\n\nGenerated Code:\n${code}\n\nExecution Result:\n${JSON.stringify(executionResult, null, 2)}`,
        'utf8'
      );

      return executionResult;
    } catch (error) {
      console.log(clc.red('✗ Failed to generate/execute next action code:'), error.message);
      throw error;
    }
  }
}

module.exports = AutomationFlow; 