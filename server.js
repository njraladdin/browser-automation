const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const { 
  addAutomationStep, 
  executeCurrentSteps, 
  clearSteps,
  closeBrowser,
  resetExecution 
} = require('./automation');

const app = express();
// Create WebSocket server
const wss = new WebSocket.Server({ port: 3001 });

// Store active connections
let connections = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
  connections.add(ws);
  
  // Add message handler
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.elementHTML) {
        // Broadcast to all frontend clients
        connections.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client !== ws) {
            client.send(JSON.stringify({ elementHTML: data.elementHTML }));
          }
        });
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });
  
  ws.on('close', () => connections.delete(ws));
});

// Add this function to broadcast clicked elements
function broadcastClickedElement(elementHTML) {
  connections.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ elementHTML }));
    }
  });
}

// Export for use in automation.js
module.exports.broadcastClickedElement = broadcastClickedElement;

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

// Add this new endpoint
app.post('/element-clicked', (req, res) => {
  const { elementHTML } = req.body;
  // Broadcast to all connected WebSocket clients
  console.log('Element clicked:', elementHTML);
  res.json({ success: true });
});

app.get('/css/output.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.sendFile(path.join(__dirname, 'public', 'css', 'output.css'));
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
}); 