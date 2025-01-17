const puppeteer = require('puppeteer');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PageSnapshot = require('./PageSnapshot');
const path = require('path');
const fs = require('fs');
const clc = require('cli-color');
const { jsonrepair } = require('jsonrepair');

class AutomationFlow {
  constructor() {
    this.pageSnapshot = new PageSnapshot();
    this.browser = null;
    this.page = null;
    this.automationSteps = [];
    this.lastExecutedStep = -1;
    this.INITIAL_URL = 'https://www.google.com';
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

  async setupStepEnvironment(stepIndex) {
    try {
      // If we're already set up for this step, skip
      if (this.lastExecutedStep === stepIndex) {
        console.log(clc.cyan('▶ Environment already set up for step:', stepIndex));
        return { success: true };
      }

      // Ensure browser is initialized
      if (!this.browser || !this.page) {
        console.log(clc.cyan('▶ Browser not initialized, initializing...'));
        await this.initBrowser();
      }

      // Create fresh snapshot
      console.log(clc.cyan('▶ Creating page snapshot...'));
      await this.pageSnapshot.captureSnapshot(this.page);

      return { success: true };
    } catch (error) {
      console.log(clc.red('✗ Step environment setup failed:'), error.message);
      return { success: false, error: error.message };
    }
  }

  async addAutomationStep(instructions, statusEmitter = () => {}) {
    try {
      console.log(clc.cyan('\n▶ Adding new automation step:'), instructions);
      
      const setup = await this.setupStepEnvironment(this.automationSteps.length);
      if (!setup.success) {
        throw new Error(setup.error);
      }

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

=== CORE REQUIREMENTS ===
• Use modern JavaScript syntax with async/await
• Always wrap code in try/catch
• Add clear console.log statements
• Return ONLY executable code
• Write code in SLOW MODE (generous delays and waits for safer execution)
• Keep in mind code may run multiple times with varying content/element counts

=== SELECTOR USAGE ===
• Use selectors from interactive map exactly as they appear (__SELECTOR__N format)
• Use IDs when available
• NEVER modify or create your own selectors
• ONLY use selectors provided in the interactive map
• DO NOT EVER USE SELECTORS THAT ARE NOT PROVIDED TO YOU
• The selectors in previous steps examples were replaced and are not accurate - do not use them

=== SHADOW DOM HANDLING ===
For elements with shadowPath:
1. Use page.evaluate() to traverse shadow DOM
2. Use element's hostSelector and shadowPath values
3. For typing:
   - Use page.keyboard.type() after focusing
   - Use promise for waiting instead of waitForTimeout

Example implementation:
try {
  console.log('Typing in search input');
  await page.evaluate(() => {
    let element = document.querySelector("__SELECTOR__N");
    // Traverse through shadow DOM using the path
    element = element?.shadowRoot?.querySelector("__SELECTOR__N");
    element = element?.shadowRoot?.querySelector("__SELECTOR__N");
    if (element) element.focus();
  });
  await page.keyboard.type('search text', {delay: 50});
} catch (error) {
  console.error('Failed to type in search:', error);
  throw error;
}

=== REGULAR ELEMENT HANDLING ===
For elements without shadowPath:
• Use standard page methods with minimal selectors
• Keep interactions simple and direct

Example implementation:
try {
  console.log('Clicking button');
  await page.click('__SELECTOR__2');
} catch (error) {
  console.error('Failed to click button:', error);
  throw error;
}

=== DATA EXTRACTION ===
Use extractStructuredContentUsingAI for all data extraction tasks by providing a description of what data to extract and its expected structure.

Example usage:
try {
  console.log('Extracting data...');
  const extractedData = await extractStructuredContentUsingAI(
    '{Detailed description of what to extract and how to structure it, including exact key names for the JSON output. See examples below.}'
  );
  console.log('Extracted data:', extractedData);
  return { success: true, extractedData };
} catch (error) {
  console.error('Failed to extract data:', error);
  throw error;
}

Description Examples:

// Products
'Extract all product listings. Structure each product with these exact keys:
 name: Product name and brand
 current_price: Current selling price
 original_price: Original price if on sale
 description: Full product description
 rating: Numeric rating value
 review_count: Number of reviews
 in_stock: Whether item is available
 badges: Array of promotional badges/labels'

// News Articles
'Extract all news articles. Structure each article with these exact keys:
 headline: Full article title
 author: Writer's name
 publish_date: Article publication date
 category: Article section/category
 summary: Preview text or summary
 read_time: Estimated reading time
 comment_count: Number of comments'

// Jobs
'Extract all job postings. Structure each job with these exact keys:
 title: Job position title
 company: Company name
 location: Full location details
 salary: Salary range if shown
 experience: Required experience level
 employment_type: Full-time/part-time/contract
 post_date: When job was posted
 requirements: Array of key qualifications'

=== INFINITE SCROLL HANDLING ===
OVERVIEW:
• Use extractStructuredContentUsingAI with extractFromNewlyAddedContent option
• Implement gradual scrolling and adequate waiting times
• Track and verify new content loading

Example implementation:
try {
  console.log('Starting infinite scroll extraction...');
  let allItems = [];
  
  // Get initial content
  const initialData = await extractStructuredContentUsingAI('Extract all product listings with their details');
  if (initialData.items) {
    allItems = [...initialData.items];
    console.log(\`Extracted \${allItems.length} initial items\`);
  }
  
  // Scroll and extract 3 more times
  for (let i = 0; i < 3; i++) {
    console.log(\`Scrolling for page \${i + 2}...\`);
    
    // Scroll 2x viewport heights to ensure triggering infinite load
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
    });
    
    // Wait for content to load (dynamic content usually needs more time)
    console.log('Waiting for new content to load...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Extract only newly loaded content
    const newData = await extractStructuredContentUsingAI(
      'Extract all product listings with their details',
      { extractFromNewlyAddedContent: true }
    );
    
    if (newData.items && newData.items.length > 0) {
      allItems = [...allItems, ...newData.items];
      console.log(\`Added \${newData.items.length} new items. Total: \${allItems.length}\`);
    } else {
      console.log('No new items found, breaking scroll loop');
      break;
    }
  }
  
  return {
    success: true,
    extractedData: {
      items: allItems,
      totalItems: allItems.length
    }
  };
} catch (error) {
  console.error('Failed to extract infinite scroll data:', error);
  throw error;
}

IMPORTANT NOTES FOR INFINITE SCROLL:
• Use extractStructuredContentUsingAI for all content extraction
• Use extractFromNewlyAddedContent: true for new content after scrolling
• Scroll gradually (about two viewport heights)
• Wait at least 3 seconds after scrolling
• Check if new items were found
• Add appropriate logging
• Return in the standard success/extractedData format
• Implement clear console logs to follow progress
• Log samples of the data being extracted

=== DYNAMIC CONTENT HANDLING ===
WHY USE findSelectorForDynamicElementUsingAI():
• The interactive map only contains selectors for elements that existed when the page was first loaded
• When new content appears dynamically (like modals), these elements aren't in our original map
• The function analyzes recent DOM changes to find and generate reliable selectors for these new elements
• It uses AI to understand your description and find the right element in the recent changes
• Without this function, you'd have no reliable way to get selectors for dynamic content

Example implementation:
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
  console.log(message);

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

INCORRECT USAGE (DON'T DO THIS):
❌ const mediaType = await findSelectorForDynamicElementUsingAI('determine if video or image');  // Wrong! Function only returns selectors
❌ const sourceUrl = await findSelectorForDynamicElementUsingAI('get the source URL');  // Wrong! Function only returns selectors

CORRECT USAGE:
✅ const mediaSelector = await findSelectorForDynamicElementUsingAI('the video or img element in the modal');
✅ const mediaType = await page.$eval(mediaSelector, el => el.tagName.toLowerCase());
✅ const sourceUrl = await page.$eval(mediaSelector, el => el.src);

IMPORTANT NOTES FOR DYNAMIC CONTENT:
• Use findSelectorForDynamicElementUsingAI() for ANY elements that appear after page changes
• This function ONLY returns a CSS selector string
• It does NOT return data, types, or any other information
• Always add a 2-second delay after the action that causes DOM changes
• The function returns a selector you can use with normal page methods
• For elements that were present when the page loaded, use the selectors from the interactive map instead

=== UNPREDICTABLE OUTCOMES ===
Use generateNextActionCodeUsingAI() for handling multiple possible outcomes after actions.

Example implementation:
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

WHEN NOT TO USE:
• For simple element waiting (use waitForSelector instead)
• For data extraction (use extractStructuredContentUsingAI instead)
• For finding dynamic elements (use findSelectorForDynamicElementUsingAI instead)

=== CURRENT PAGE INFO ===
URL: ${snapshot.url}

Interactive Map:
${JSON.stringify(snapshot.interactive, null, 2)}

Content Map:
${PageSnapshot.condenseContentMap(snapshot.content)}

=== PREVIOUS STEPS ===
${previousSteps ? `Previous automation steps:
${previousSteps}` : 'No previous steps'}

=== USER INSTRUCTIONS ===
${instructions}`;


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

  async extractStructuredContentUsingAI(structurePrompt, options = { extractFromNewlyAddedContent: false }) {
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

      // Get content based on option
      let contentToProcess;
      if (options.extractFromNewlyAddedContent) {
        console.log(clc.cyan('▶ Extracting from newly added content...'));
        const latestChanges = this.pageSnapshot.getLatestDOMChanges();
        
        if (!latestChanges || latestChanges.length === 0) {
          console.log(clc.yellow('⚠ No new content found in DOM changes'));
          return { items: [] };
        }

        contentToProcess = latestChanges
          .filter(change => change.addedNodes?.length > 0 || change.contentMap)
          .map(change => {
            const contentMap = change.contentMap || 
              this.pageSnapshot.createContentMapFromNodes(change.addedNodes);
            return PageSnapshot.condenseContentMap(contentMap);
          })
          .filter(Boolean)
          .join('\n---\n');
      } else {
        console.log(clc.cyan('▶ Extracting from current page content...'));
        contentToProcess = PageSnapshot.condenseContentMap(this.pageSnapshot.getContentMap());
      }

      const systemPrompt = `You are an AI assistant that parses webpage content and extracts structured information.

      Input Content from Webpage:
      ${contentToProcess}

      The content is formatted as:
      - Each entry starts with [tag_name] indicating the HTML element type
      - If present, aria-label is included in the tag brackets
      - Text content follows directly after the tag
      - Media entries include src: and optional alt: attributes
      - Entries are separated by ---

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

      const startTime = Date.now();
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: systemPrompt }]}]
      });

      const response = await result.response;
      const parsedText = response.text();
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(clc.green(`✓ AI response received in ${processingTime}s`));

      // Save debug file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const testDir = path.join(__dirname, 'test');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }

      fs.writeFileSync(
        path.join(testDir, `ai_parsed_${options.extractFromNewlyAddedContent ? 'dynamic_' : ''}${timestamp}.txt`),
        `Structure Prompt:\n${structurePrompt}\n\nContent Map:\n${JSON.stringify(contentToProcess, null, 2)}\n\nParsed Result:\n${parsedText}`,
        'utf8'
      );

      try {
        const result = JSON.parse(parsedText);
        console.log(clc.green(`✓ Successfully parsed ${options.extractFromNewlyAddedContent ? 'new' : 'current'} content with AI`));
        return result;
      } catch (e) {
        console.log(clc.yellow('⚠ AI response was not valid JSON, attempting to repair JSON'));
        try {
          const repairedText = jsonrepair(parsedText);
          const repairedResult = JSON.parse(repairedText);
          console.log(clc.green(`✓ Successfully repaired and parsed ${options.extractFromNewlyAddedContent ? 'new' : 'current'} content with AI`));
          return repairedResult;
        } catch (repairError) {
          console.log(clc.red('✗ JSON repair failed, returning raw text'));
          return parsedText;
        }
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
      
      const setup = await this.setupStepEnvironment(stepIndex);
      if (!setup.success) {
        throw new Error(setup.error);
      }

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

      // Process content maps
      const contentChanges = latestChanges
        .filter(change => change.contentMap)
        .map(change => PageSnapshot.condenseContentMap(change.contentMap))
        .filter(Boolean)
        .join('\n\n=== New Content Change ===\n\n');

      // Process interactive maps
      const interactiveChanges = latestChanges
        .filter(change => change.interactiveMap)
        .map(change => JSON.stringify(change.interactiveMap, null, 2))
        .filter(Boolean)
        .join('\n\n=== New Interactive Change ===\n\n');

      const systemPrompt = `You are an AI assistant that finds DOM elements in newly added content.

Latest Content Changes:
${contentChanges}

Latest Interactive Changes:
${interactiveChanges}

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

      // Save prompt for testing/debugging
      const testDir = path.join(__dirname, 'test');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir);
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(
        path.join(testDir, `selector_prompt_${timestamp}.txt`),
        systemPrompt,
        'utf8'
      );

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
5. Return an object with:
   - success: boolean indicating success/failure
   - data: any extracted data (optional)

Example Response Format:
try {
  console.log('Checking for possible outcomes...');
  
  // Check for success message with data
  const result = await page.evaluate(() => {
    const successEl = document.querySelector('.success-message, .alert-success');
    const dataEl = document.querySelector('.result-data');
    
    return {
      success: successEl !== null && successEl.textContent.includes('Successfully'),
      data: dataEl ? dataEl.textContent : null
    };
  });

  if (result.success) {
    console.log('Success outcome detected');
    return result;
  }

  // Check for validation errors
  const hasErrors = await page.evaluate(() => {
    const errorEl = document.querySelector('.error-message, .validation-error');
    return errorEl !== null;
  });

  if (hasErrors) {
    console.log('Validation errors detected');
    return { success: false };
  }

  // Check for verification required
  const needsVerification = await page.evaluate(() => {
    const verifyEl = document.querySelector('.verify-prompt');
    return verifyEl !== null;
  });

  if (needsVerification) {
    console.log('Verification required');
    return { success: false };
  }

  return { success: true };  // Default success case

} catch (error) {
  console.error('Failed to handle outcome:', error);
  return { success: false };
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