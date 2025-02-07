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

// Add a Map to track flow connections
const flowConnections = new Map(); // flowId -> Set of socket IDs

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

    // Create a status emitter for this flow
    const statusEmitter = (status) => emitFlowStatus(flowId, status);

    // Add and execute the step, passing the status emitter
    const result = await flow.automationFlowInstance.addAutomationStep(
      instructions, 
      statusEmitter
    );
    
    if (result.success) {
      await flowManager.addStepToFlow(flowId, instructions, result.code);
      res.json({
        success: true,
        code: result.code,
        screenshot: result.screenshot,
        extractedData: result.extractedData
      });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    emitFlowStatus(req.params.flowId, { 
      message: `Server error: ${error.message}`, 
      type: 'error',
      stepIndex: -1
    });
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

    const result = await flow.automationFlowInstance.resetExecution();
    res.json(result);
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
      if (room !== socket.id) {
        socket.leave(room);
        // Remove socket from previous flow's connections
        const flowIdMatch = room.match(/^flow-(.+)$/);
        if (flowIdMatch) {
          const previousFlowId = flowIdMatch[1];
          const connections = flowConnections.get(previousFlowId);
          if (connections) {
            connections.delete(socket.id);
            if (connections.size === 0) {
              handleFlowDisconnection(previousFlowId);
            }
          }
        }
      }
    });
    
    // Join new flow room
    socket.join(`flow-${flowId}`);
    console.log(`Client joined flow-${flowId}`);

    // Track this connection
    if (!flowConnections.has(flowId)) {
      flowConnections.set(flowId, new Set());
    }
    flowConnections.get(flowId).add(socket.id);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Check all flows this socket was connected to
    flowConnections.forEach((connections, flowId) => {
      if (connections.has(socket.id)) {
        connections.delete(socket.id);
        if (connections.size === 0) {
          handleFlowDisconnection(flowId);
        }
      }
    });
  });
});

// Add helper function to handle flow disconnection
async function handleFlowDisconnection(flowId) {
  console.log(`All clients disconnected from flow ${flowId}, deactivating...`);
  try {
    const flow = await flowManager.getFlow(flowId);
    if (flow) {
      // Close browser and deactivate flow
      if (flow.automationFlowInstance) {
        await flow.automationFlowInstance.closeBrowser();
      }
      flowManager.activeFlows.delete(flowId);
      console.log(`Successfully deactivated flow ${flowId}`);
    }
  } catch (error) {
    console.error(`Error deactivating flow ${flowId}:`, error);
  }
}

// Add this helper function to emit status updates
function emitFlowStatus(flowId, status) {
  console.log(status);
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
    
    // Just return the result directly - it already contains the steps with screenshots!
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

// Add API key management endpoints
app.get('/profiles/:username/api-key', async (req, res) => {
  try {
    const { username } = req.params;
    const profile = await flowManager.db.get(
      'SELECT gemini_api_key FROM profiles WHERE profile_username = ?',
      [username]
    );
    
    if (profile) {
      res.json({ gemini_api_key: profile.gemini_api_key });
    } else {
      res.status(404).json({ error: 'Profile not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/profiles/:username/api-key', async (req, res) => {
  try {
    const { username } = req.params;
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }

    await flowManager.db.run(
      'UPDATE profiles SET gemini_api_key = ? WHERE profile_username = ?',
      [apiKey, username]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this new endpoint after the other flow endpoints:
app.delete('/flows/:flowId/step/:stepIndex', async (req, res) => {
  try {
    const { flowId, stepIndex } = req.params;
    const flow = await flowManager.getFlow(flowId);
    
    if (!flow) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const result = await flowManager.deleteStep(flowId, parseInt(stepIndex));
    
    if (result.success) {
      // Get updated steps after deletion
      const updatedSteps = await flowManager.getFlowSteps(flowId);
      res.json({ 
        success: true, 
        steps: updatedSteps,
        lastExecutedStep: flow.automationFlowInstance.lastExecutedStep
      });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
}); 