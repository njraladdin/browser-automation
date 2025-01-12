const AutomationFlow = require('./AutomationFlow');
const DatabaseManager = require('./DatabaseManager');
/*
about flow timeout: 
when the user gets a flow, we start a timer for 20 minutes (he selects a flow in the frontend)
after 20 minutes, we simply deactivate the flow (close browser, clear any instances or state)

this is to prevent the browser being left open for too long (chrome)

the frontend 
*/
class FlowManager {
  constructor() {
    this.db = new DatabaseManager();
    this.activeFlows = new Map();
    this.SESSION_TIMEOUT = 20 * 60 * 1000; // 20 minutes
  }

  async createFlow(name, description = '', profileId) {
    const flowId = `flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const createdAt = new Date().toISOString();

    try {
      await this.db.run(
        'INSERT INTO flows (id, name, description, created_at, profile_id) VALUES (?, ?, ?, ?, ?)',
        [flowId, name, description, createdAt, profileId]
      );

      const flow = {
        id: flowId,
        name,
        description,
        createdAt,
        automationFlowInstance: new AutomationFlow()
      };

      // Set timeout to close browser after 20 minutes
      setTimeout(async () => {
        console.log(`Flow ${flowId} reached 20 minute limit, closing browser...`);
        if (this.activeFlows.has(flowId)) {
          const flow = this.activeFlows.get(flowId);
          if (flow.automationFlowInstance) {
            await flow.automationFlowInstance.closeBrowser();
          }
          this.activeFlows.delete(flowId);
        }
      }, this.SESSION_TIMEOUT);

      this.activeFlows.set(flowId, flow);
      return flow;
    } catch (error) {
      console.error('Failed to create flow:', error);
      throw error;
    }
  }

  async getFlow(flowId) {
    try {
      console.log(`[FlowManager] Getting flow ${flowId}`);
      
      // Check if flow is already active
      if (this.activeFlows.has(flowId)) {
        console.log('[FlowManager] Found flow in active flows');
        return this.activeFlows.get(flowId);
      }

      // Get flow from database
      const flow = await this.db.get(
        'SELECT * FROM flows WHERE id = ?',
        [flowId]
      );

      if (!flow) {
        console.log('[FlowManager] Flow not found in database');
        return null;
      }

      // Get steps for this flow
      const steps = await this.db.all(
        'SELECT * FROM steps WHERE flow_id = ? ORDER BY order_index',
        [flowId]
      );
      
      console.log('[FlowManager] Retrieved steps from database:');

      // Create new automation instance
      const automationFlowInstance = new AutomationFlow();
      
      // Load steps into automation instance
      for (const step of steps) {
        console.log('[FlowManager] Loading step into automation:', step.instructions);
        automationFlowInstance.automationSteps.push({
          instructions: step.instructions,
          code: step.code
        });
      }
      
      // Reconstruct the flow with its automation instance
      const activeFlow = {
        ...flow,
        automationFlowInstance,
        steps
      };

      // Store in active flows
      this.activeFlows.set(flowId, activeFlow);
      console.log('[FlowManager] Flow activated ');
      return activeFlow;
    } catch (error) {
      console.error('[FlowManager] Failed to get flow:', error);
      throw error;
    }
  }

  async getAllFlows() {
    try {
      return await this.db.all('SELECT * FROM flows ORDER BY created_at DESC');
    } catch (error) {
      console.error('Failed to get all flows:', error);
      throw error;
    }
  }

  async deleteFlow(flowId) {
    try {
      // Clean up automation if active
      if (this.activeFlows.has(flowId)) {
        const flow = this.activeFlows.get(flowId);
        if (flow.automationFlowInstance) {
          await flow.automationFlowInstance.closeBrowser();
        }
        this.activeFlows.delete(flowId);
      }

      // Delete from database
      await this.db.run('DELETE FROM steps WHERE flow_id = ?', [flowId]);
      await this.db.run('DELETE FROM flows WHERE id = ?', [flowId]);

      return true;
    } catch (error) {
      console.error('Failed to delete flow:', error);
      throw error;
    }
  }

  async addStepToFlow(flowId, instructions, code) {
    try {
      // Get current highest order index
      const lastStep = await this.db.get(
        'SELECT MAX(order_index) as max_order FROM steps WHERE flow_id = ?',
        [flowId]
      );
      const orderIndex = (lastStep?.max_order ?? -1) + 1;

      // Insert new step
      await this.db.run(
        'INSERT INTO steps (flow_id, instructions, code, order_index) VALUES (?, ?, ?, ?)',
        [flowId, instructions, code, orderIndex]
      );

      return { success: true, orderIndex };
    } catch (error) {
      console.error('Failed to add step:', error);
      throw error;
    }
  }

  async getFlowSteps(flowId) {
    try {
      return await this.db.all(
        'SELECT * FROM steps WHERE flow_id = ? ORDER BY order_index',
        [flowId]
      );
    } catch (error) {
      console.error('Failed to get flow steps:', error);
      throw error;
    }
  }

  async getAllFlowsForUser(profileId) {
    try {
      return await this.db.all(
        'SELECT * FROM flows WHERE profile_id = ? ORDER BY created_at DESC',
        [profileId]
      );
    } catch (error) {
      console.error('Failed to get flows for profile:', error);
      throw error;
    }
  }
}

module.exports = FlowManager; 