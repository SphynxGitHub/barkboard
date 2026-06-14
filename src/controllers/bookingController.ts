import { Request, Response } from 'express';
import { BookingService } from '../services/bookingService';

export async function handleNewBookingRequest(req: Request, res: Response) {
  try {
    const contextBooking = await BookingService.createReservation({
      ownerId: req.body.ownerId,
      petIds: req.body.petIds,
      serviceTypeId: req.body.serviceTypeId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      totalAmount: req.body.totalAmount
    });

    return res.status(201).json({
      success: true,
      message: "Reservation confirmed and physical assets held successfully.",
      data: contextBooking
    });
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: error.message || "An unexpected error occurred during resource allocation routing."
    });
  }
}
