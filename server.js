const express = require('express');
const path = require('path');
const AutomationFlow = require('./AutomationFlow');
const FlowManager = require('./FlowManager');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
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
    const { name, description, profile_id } = req.body;
    const flow = await flowManager.createFlow(name, description, profile_id);
    res.json(flow);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/flows', async (req, res) => {
  try {
    const { profile_id } = req.query;
    if (!profile_id) {
      return res.json([]);
    }
    
    const flows = await flowManager.getAllFlowsForUser(profile_id);
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
      emitFlowStatus(flowId, { 
        message: 'Flow not found', 
        type: 'error',
        stepIndex: flow?.automationFlowInstance?.automationSteps?.length || 0
      });
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const result = await flow.automationFlowInstance.addAutomationStep(instructions);
    if (result.success) {
      await flowManager.addStepToFlow(flowId, instructions, result.code);
    } else {
      emitFlowStatus(flowId, { 
        message: `Failed to add step: ${result.error}`, 
        type: 'error',
        stepIndex: flow.automationFlowInstance.automationSteps.length
      });
    }
    res.json(result);
  } catch (error) {
    emitFlowStatus(req.params.flowId, { 
      message: `Server error: ${error.message}`, 
      type: 'error',
      stepIndex: -1
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/flows/:flowId/execute', async (req, res) => {
  try {
    const { flowId } = req.params;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const result = await flow.automationFlowInstance.executeCurrentSteps();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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

    await flow.automationFlowInstance.resetExecution();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected');
  
  socket.on('join-flow', (flowId) => {
    // Leave previous flow room if any
    Object.keys(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    
    // Join new flow room
    socket.join(`flow-${flowId}`);
    console.log(`Client joined flow-${flowId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Add this helper function to emit status updates
function emitFlowStatus(flowId, status) {
  console.log(`Emitting status for flow ${flowId}:`, status);
  io.to(`flow-${flowId}`).emit('flow-status', status);
}

// Update the execute-step endpoint to use status updates
app.post('/flows/:flowId/execute-step/:stepIndex', async (req, res) => {
  try {
    const { flowId, stepIndex } = req.params;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      emitFlowStatus(flowId, { 
        message: 'Flow not found', 
        type: 'error',
        stepIndex: parseInt(stepIndex)
      });
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const statusEmitter = (status) => emitFlowStatus(flowId, status);
    const result = await flow.automationFlowInstance.executeSingleStep(parseInt(stepIndex), statusEmitter);
    res.json(result);
  } catch (error) {
    emitFlowStatus(req.params.flowId, { 
      message: `Server error: ${error.message}`, 
      type: 'error',
      stepIndex: parseInt(req.params.stepIndex)
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create/verify profile
app.post('/profiles', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Check if profile exists
    const existing = await flowManager.db.get(
      'SELECT profile_id, profile_username FROM profiles WHERE profile_username = ?',
      [username]
    );

    if (!existing) {
      // Create new profile with generated ID
      const profileId = `profile_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await flowManager.db.run(
        'INSERT INTO profiles (profile_id, profile_username, created_at) VALUES (?, ?, ?)',
        [profileId, username, new Date().toISOString()]
      );
      res.json({ profile_id: profileId, profile_username: username });
    } else {
      res.json(existing);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify profile exists
app.get('/profiles/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const profile = await flowManager.db.get(
      'SELECT profile_id, profile_username FROM profiles WHERE profile_username = ?',
      [username]
    );
    
    if (profile) {
      res.json(profile);
    } else {
      res.status(404).json({ error: 'Profile not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
}); 