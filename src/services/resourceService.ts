// Mocking database access interface
import { db } from '../config/database';
import { getDaysArray } from '../utils/dateHelpers';

export class ResourceService {
  /**
   * Core Utility: Computes availability metrics for a specific resource archetype over a month
   */
  static async checkAvailability(
    resourceType: string,
    yearMonth: string // e.g., "2026-07"
  ): Promise<{ [date: string]: number }> {
    
    // 1. Fetch total static capacity for the chosen asset type
    const resources = await db.table('resources')
      .where({ type: resourceType, status: 'active' });
    
    const totalCapacity = resources.reduce((acc, res) => acc + res.capacity_limit, 0);

    // 2. Fetch all conflicting allocations for that target timeframe
    const allocations = await db.table('resource_allocations')
      .join('resources', 'resource_allocations.resource_id', 'resources.resource_id')
      .where('resources.type', resourceType)
      .whereRaw("to_char(allocated_from, 'YYYY-MM') = ?", [yearMonth]);

    const dailyOccupancy: { [date: string]: number } = {};

    // 3. Tally daily occupancy footprints
    allocations.forEach(alloc => {
      const days = getDaysArray(alloc.allocated_from, alloc.allocated_to);
      days.forEach(day => {
        dailyOccupancy[day] = (dailyOccupancy[day] || 0) + 1;
      });
    });

    // 4. Construct a remaining inventory manifest
    const remainingInventory: { [date: string]: number } = {};
    Object.keys(dailyOccupancy).forEach(day => {
      remainingInventory[day] = totalCapacity - dailyOccupancy[day];
    });

    return remainingInventory; // Returns mapping like {"2026-07-08": 1, "2026-07-09": 0}
  }
}
