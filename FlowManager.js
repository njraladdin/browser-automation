const AutomationFlow = require('./automation');
const DatabaseManager = require('./DatabaseManager');

class FlowManager {
  constructor() {
    this.db = new DatabaseManager();
    this.activeFlows = new Map(); // Keep track of active automation instances
  }

  async createFlow(name, description = '') {
    const flowId = `flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const createdAt = new Date().toISOString();

    try {
      await this.db.run(
        'INSERT INTO flows (id, name, description, created_at) VALUES (?, ?, ?, ?)',
        [flowId, name, description, createdAt]
      );

      const flow = {
        id: flowId,
        name,
        description,
        createdAt,
        automation: new AutomationFlow()
      };

      this.activeFlows.set(flowId, flow);
      return flow;
    } catch (error) {
      console.error('Failed to create flow:', error);
      throw error;
    }
  }

  async getFlow(flowId) {
    try {
      // Check if flow is already active
      if (this.activeFlows.has(flowId)) {
        return this.activeFlows.get(flowId);
      }

      // Get flow from database
      const flow = await this.db.get(
        'SELECT * FROM flows WHERE id = ?',
        [flowId]
      );

      if (!flow) return null;

      // Get steps for this flow
      const steps = await this.db.all(
        'SELECT * FROM steps WHERE flow_id = ? ORDER BY order_index',
        [flowId]
      );

      // Create new automation instance
      const automation = new AutomationFlow();
      
      // Reconstruct the flow with its automation instance
      const activeFlow = {
        ...flow,
        automation,
        steps
      };

      // Store in active flows
      this.activeFlows.set(flowId, activeFlow);
      return activeFlow;
    } catch (error) {
      console.error('Failed to get flow:', error);
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
        if (flow.automation) {
          await flow.automation.closeBrowser();
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
}

module.exports = FlowManager; 