import { db } from '../config/database';
import { isVaccinationValid } from '../utils/validators';
import { ResourceService } from './resourceService';
import { getDaysArray } from '../utils/dateHelpers';

interface BookingPayload {
  ownerId: string;
  petIds: string[];
  serviceTypeId: string;
  startDate: string;
  endDate: string;
  totalAmount: number;
}

export class BookingService {
  static async createReservation(payload: BookingPayload) {
    return await db.transaction(async (trx) => {
      
      // 1. Fetch Service Archetype Rules
      const service = await trx('services').where({ service_type_id: payload.serviceTypeId }).first();
      const requiredType = service.resource_types_required[0]; // e.g., 'kennel_luxury'

      // 2. Run Availability Pre-flight check via our utility module
      const targetMonth = payload.startDate.substring(0, 7);
      const inventory = await ResourceService.checkAvailability(requiredType, targetMonth);
      const requestedDays = getDaysArray(payload.startDate, payload.endDate);

      for (const day of requestedDays) {
        const availableSlots = inventory[day] !== undefined ? inventory[day] : service.max_default_capacity;
        if (availableSlots < payload.petIds.length) {
          throw new Error(`Inventory exhausted for requested asset on date: ${day}`);
        }
      }

      // 3. Health Compliancy Sweep
      for (const petId of payload.petIds) {
        const pet = await trx('pets').where({ pet_id: petId }).first();
        if (!isVaccinationValid(pet, payload.endDate)) {
          throw new Error(`Health safety compliance block: ${pet.name} lacks valid documentation.`);
        }
      }

      // 4. Persistence Entry: Create Parent Booking Row
      const [booking] = await trx('bookings').insert({
        owner_id: payload.ownerId,
        status: 'confirmed',
        total_amount: payload.totalAmount
      }).returning('*');

      // 5. Loop and allocate atomic line records + physical beds
      for (const petId of payload.petIds) {
        const [bookingItem] = await trx('booking_items').insert({
          booking_id: booking.booking_id,
          pet_id: petId,
          service_type_id: payload.serviceTypeId,
          start_date: payload.startDate,
          end_date: payload.endDate,
          status: 'scheduled'
        }).returning('*');

        // Dynamically locate a vacant static resource id slot
        const availableResource = await trx('resources')
          .where({ type: requiredType, status: 'active' })
          .whereNotIn('resource_id', function() {
            this.select('resource_id').from('resource_allocations')
              .where('allocated_from', '<=', payload.endDate)
              .where('allocated_to', '>=', payload.startDate);
          })
          .first();

        // Save physical slot allocation reservation ledger row
        await trx('resource_allocations').insert({
          booking_item_id: bookingItem.booking_item_id,
          resource_id: availableResource.resource_id,
          allocated_from: payload.startDate,
          allocated_to: payload.endDate
        });
      }

      // 6. Generate Invoice Row Shell
      await trx('invoices').insert({
        booking_id: booking.booking_id,
        amount_due: payload.totalAmount,
        status: 'unpaid'
      });

      return booking; // Transaction resolves and saves seamlessly!
    });
  }
}
