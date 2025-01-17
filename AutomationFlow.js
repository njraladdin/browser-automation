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
    this.aiSelectorResults = [];
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async initBrowser(statusEmitter = () => {}) {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page };
    }

    if (this.browserInitializing) {
      return this.browserInitializing;
    }

    this.browserInitializing = (async () => {
      try {
        statusEmitter({ message: 'Launching browser...' });
        console.log(clc.cyan('▶ Launching browser...'));
        this.browser = await puppeteer.launch({ 
          headless: false,
          defaultViewport: {
            width: 1280,
            height: 800
          }
        });

        statusEmitter({ message: 'Browser launched successfully' });

        // Add handler for browser disconnection
        this.browser.on('disconnected', async () => {
          console.log(clc.yellow('⚠ Browser was disconnected or closed'));
          statusEmitter({ message: 'Browser was disconnected or closed' });
          this.browser = null;
          this.page = null;
          await this.resetExecution();
        });

        this.page = await this.browser.newPage();
        
        statusEmitter({ message: `Navigating to ${this.INITIAL_URL}...` });
        console.log(clc.cyan('▶ Navigating to initial URL...'));
        try {
          await this.page.goto(this.INITIAL_URL, { waitUntil: 'networkidle0' });
          console.log(clc.green('✓ Page loaded successfully'));
          statusEmitter({ message: 'Page loaded successfully' });
        } catch (navigationError) {
          if (navigationError.message.includes('detached') || navigationError.message.includes('disconnected')) {
            console.log(clc.yellow('⚠ Browser was closed during navigation'));
            statusEmitter({ message: 'Browser was closed during navigation' });
            this.browser = null;
            this.page = null;
            await this.resetExecution();
            throw navigationError;
          }
          throw new Error(`Failed to load initial page: ${navigationError.message}`);
        }
        
        return { browser: this.browser, page: this.page };
      } catch (error) {
        console.log(clc.red('✗ Browser initialization failed:'), error.message);
        statusEmitter({ message: `Browser initialization failed: ${error.message}` });
        this.browser = null;
        this.page = null;
        await this.resetExecution();
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

  async setupStepEnvironment(stepIndex, statusEmitter = () => {}) {
    try {
      // If we're already set up for this step, skip
      if (this.lastExecutedStep === stepIndex) {
        console.log(clc.cyan('▶ Environment already set up for step:', stepIndex));
        return { success: true, browser: this.browser, page: this.page };
      }

      // Check step order - only allow executing next step or re-running previous steps
      if (stepIndex > this.lastExecutedStep + 1) {
        console.log(clc.red('✗ Cannot skip steps. Requested step:', stepIndex, 'Last executed step:', this.lastExecutedStep));
        return { 
          success: false, 
          error: `Cannot execute step ${stepIndex + 1} before completing previous steps. Last completed step: ${this.lastExecutedStep + 1}` 
        };
      }

      // Ensure browser is initialized
      if (!this.browser || !this.page) {
        console.log(clc.cyan('▶ Browser not initialized, initializing...'));
        const { browser, page } = await this.initBrowser(statusEmitter);
        this.browser = browser;
        this.page = page;
      }

      // Create fresh snapshot
      console.log(clc.cyan('▶ Creating page snapshot...'));
      await this.pageSnapshot.captureSnapshot(this.page);

      return { success: true, browser: this.browser, page: this.page };
    } catch (error) {
      console.log(clc.red('✗ Step environment setup failed:'), error.message);
      return { success: false, error: error.message };
    }
  }

  async addAutomationStep(instructions, statusEmitter = () => {}) {
    try {
      console.log(clc.cyan('\n▶ Adding new automation step:'), instructions);
      
      const setup = await this.setupStepEnvironment(this.automationSteps.length, statusEmitter);
      if (!setup.success) {
        throw new Error(setup.error);
      }
      
      // Use the browser and page from setup
      this.browser = setup.browser;
      this.page = setup.page;

      statusEmitter({ message: 'Generating code for new step...', stepIndex: this.automationSteps.length });
      
      // Remove redundant browser initialization since setupStepEnvironment handles it
      
      statusEmitter({ message: 'Analyzing page and generating automation code...', stepIndex: this.automationSteps.length });

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

      const systemPrompt = await this.loadPrompt('generate_automation_step', {
        url: snapshot.url,
        interactive: JSON.stringify(snapshot.interactive, null, 2),
        content: PageSnapshot.condenseContentMap(snapshot.content),
        previous_steps: previousSteps || 'No previous steps',
        instructions: instructions,
        step_index: this.automationSteps.length
      });

      await this.savePromptForDebug(systemPrompt, instructions);
      
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
        statusEmitter({ message: 'Replacing AI selectors with concrete values...', stepIndex });
        
        const updatedCode = await this.replaceAISelectorsWithConcreteSelectors(
          code, 
          this.aiSelectorResults
        );
        
        // Update the step's code with concrete selectors
        this.automationSteps[stepIndex].code = updatedCode;
        code = updatedCode; // Update the code that will be returned
        
        statusEmitter({ message: 'Successfully replaced AI selectors with concrete values', stepIndex });
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
      statusEmitter({ message: `Failed: ${error.message}`, stepIndex: this.automationSteps.length });
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
            return PageSnapshot.condenseContentMap(contentMap, false);
          })
          .filter(Boolean)
          .join('\n---\n');
      } else {
        console.log(clc.cyan('▶ Extracting from current page content...'));
        contentToProcess = PageSnapshot.condenseContentMap(this.pageSnapshot.getContentMap(), false);
      }


      const systemPrompt = await this.loadPrompt('extract_structured_content', {
        content: contentToProcess,
        structure_prompt: structurePrompt
      });

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
      
      const setup = await this.setupStepEnvironment(stepIndex, statusEmitter);
      if (!setup.success) {
        throw new Error(setup.error);
      }

      // Reset AI selector results at the start
      this.aiSelectorResults = [];
      
      // Emit starting status
      statusEmitter({ message: 'Starting step execution...', stepIndex });
      if (!this.browser || !this.page) {
        console.log(clc.cyan('▶ Browser not initialized, initializing...'));
        try {
          await this.initBrowser(statusEmitter);
        } catch (browserError) {
          statusEmitter({ message: `Browser initialization failed: ${browserError.message}`, stepIndex });
          console.log(clc.red('✗ Browser initialization failed:'), browserError.message);
          throw browserError;
        }
      }

      if (stepIndex < 0 || stepIndex >= this.automationSteps.length) {
        throw new Error('Invalid step index');
      }

      const step = this.automationSteps[stepIndex];
      this.lastExecutedStep = stepIndex;
      
      statusEmitter({ message: 'Executing automation code...', stepIndex });

      // Execute the step - now including statusEmitter in the context
      const stepFunction = new Function(
        'page', 
        'extractStructuredContentUsingAI',
        'findSelectorForDynamicElementUsingAI',
        'statusEmitter',
        `return (async (page, extractStructuredContentUsingAI, findSelectorForDynamicElementUsingAI, statusEmitter) => {
          ${step.code}
        })(page, extractStructuredContentUsingAI, findSelectorForDynamicElementUsingAI, statusEmitter)`
      );

      try {
        const result = await stepFunction(
          this.page, 
          this.extractStructuredContentUsingAI.bind(this),
          this.findSelectorForDynamicElementUsingAI.bind(this),
          statusEmitter
        );

        // Store extracted data if present
        if (result && result.success && result.extractedData) {
          this.automationSteps[stepIndex].extractedData = result.extractedData;
        }

        statusEmitter({ message: 'Step executed successfully', stepIndex });
      } catch (executionError) {
        statusEmitter({ message: `Failed: ${executionError.message}`, stepIndex });
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
      console.log(this.automationSteps)
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

      const systemPrompt = await this.loadPrompt('find_dynamic_selector', {
        content_changes: contentChanges,
        interactive_changes: interactiveChanges,
        description: description
      });

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
      
      const systemPrompt = await this.loadPrompt('replace_concrete_selectors', {
        code: code,
        selector_results: JSON.stringify(selectorResults, null, 2)
      });

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

      const systemPrompt = await this.loadPrompt('generate_next_action', {
        latest_changes: JSON.stringify(latestChanges, null, 2),
        content_map: JSON.stringify(contentMap, null, 2),
        description: description
      });

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

  async loadPrompt(promptName, replacements = {}) {
    try {
      const promptPath = path.join(__dirname, 'prompts', `${promptName}.txt`);
      let promptTemplate = fs.readFileSync(promptPath, 'utf8');
      
      // Replace all placeholders with their values
      Object.entries(replacements).forEach(([key, value]) => {
        promptTemplate = promptTemplate.replace(`{{${key}}}`, value);
      });
      
      return promptTemplate;
    } catch (error) {
      console.log(clc.red('✗ Failed to load prompt:'), error.message);
      throw error;
    }
  }
}

module.exports = AutomationFlow; 