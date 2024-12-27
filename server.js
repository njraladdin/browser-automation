const express = require('express');
const path = require('path');
const { 
  addAutomationStep, 
  executeCurrentSteps, 
  clearSteps,
  closeBrowser,
  resetExecution 
} = require('./automation');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/css', express.static('public/css', {
  setHeaders: (res, path) => {
    if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
  }
}));

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add new automation step
app.post('/step', async (req, res) => {
  const { instructions } = req.body;
  const result = await addAutomationStep(instructions);
  res.json(result);
});

// Execute all current steps
app.post('/execute', async (req, res) => {
  const result = await executeCurrentSteps();
  res.json(result);
});

// Clear all steps
app.post('/clear', async (req, res) => {
  const result = await clearSteps();
  res.json(result);
});

// Close browser
app.post('/close', async (req, res) => {
  const result = await closeBrowser();
  res.json(result);
});

// Add new endpoint to reset execution pointer
app.post('/reset-execution', async (req, res) => {
  const result = await resetExecution();
  res.json(result);
});

app.get('/css/output.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.sendFile(path.join(__dirname, 'public', 'css', 'output.css'));
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
}); 