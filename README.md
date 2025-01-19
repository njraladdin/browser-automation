
# Web Automation Builder

A browser automation tool that lets you create automation flows using natural language instructions. Write what you want to do in plain English, and the AI will generate and execute the appropriate automation code.

## What it does

- Converts natural language instructions into working browser automation code
- Executes automation steps with real-time visual feedback
- Captures screenshots and extracted data for each step
- Saves flows for reuse and sharing
- Handles dynamic content and complex interactions

## Benchmarks

Successfully automated common web tasks like:
- Scraping Instagram stories from anonymous profiles
- Extracting 1000 Airbnb listings while handling infinite scroll
- Collecting 100 posts from Twitter profiles
- Filling out Facebook signup forms

## Setup

1. Clone the repository
2. Install dependencies:
```bash
npm install
```
3. Start the server:
```bash
npm start
```
4. Open `http://localhost:3000` in your browser

## Usage

1. Create a profile when first launching the app
2. Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
3. Click the "API Key" button in the top right and enter your key
4. Click "New Flow" and give it a name
5. Enter instructions in natural language, for example:
   - "Go to wikipedia.org"
   - "Type 'artificial intelligence' in the search box"
   - "Click the first search result"
6. Each step will be executed automatically and show:
   - Generated automation code
   - Screenshot of the result
   - Any extracted data
7. Use "Play All Steps" to run the entire flow from start to finish

## Tips

- Be specific in your instructions (e.g., "Click the blue 'Submit' button" instead of just "Click submit")
- For data extraction, specify the format you want (e.g., "Extract all product titles and prices into a list")
- Use the reset button if you need to start over
- Check the screenshots to verify each step worked as expected
