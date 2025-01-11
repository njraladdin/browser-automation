const express = require('express');
const path = require('path');
const AutomationFlow = require('./automation');
const FlowManager = require('./FlowManager');

const app = express();
const flowManager = new FlowManager();

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

// Flow management endpoints
app.post('/flows', async (req, res) => {
  try {
    const { name, description } = req.body;
    const flow = await flowManager.createFlow(name, description);
    res.json(flow);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/flows', async (req, res) => {
  try {
    const flows = await flowManager.getAllFlows();
    res.json(flows);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/flows/:flowId/steps', async (req, res) => {
  try {
    const { flowId } = req.params;
    const steps = await flowManager.getFlowSteps(flowId);
    res.json(steps);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/flows/:flowId/step', async (req, res) => {
  try {
    const { flowId } = req.params;
    const { instructions } = req.body;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const result = await flow.automation.addAutomationStep(instructions);
    if (result.success) {
      await flowManager.addStepToFlow(flowId, instructions, result.code);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/flows/:flowId/execute', async (req, res) => {
  const { flowId } = req.params;
  const flow = flowManager.getFlow(flowId);
  
  if (!flow) {
    return res.status(404).json({ success: false, error: 'Flow not found' });
  }

  const result = await flow.automation.executeCurrentSteps();
  res.json(result);
});

// Clear all steps
app.post('/clear', async (req, res) => {
  const result = await automationFlow.clearSteps();
  res.json(result);
});

// Close browser
app.post('/close', async (req, res) => {
  const result = await automationFlow.closeBrowser();
  res.json(result);
});

// Add new endpoint to reset execution pointer
app.post('/reset-execution', async (req, res) => {
  const result = await automationFlow.resetExecution();
  res.json(result);
});

app.post('/flows/:flowId/reset', async (req, res) => {
  try {
    const { flowId } = req.params;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    await flow.automation.resetExecution();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/flows/:flowId/execute-step/:stepIndex', async (req, res) => {
  try {
    const { flowId, stepIndex } = req.params;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const result = await flow.automation.executeSingleStep(parseInt(stepIndex));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
}); 