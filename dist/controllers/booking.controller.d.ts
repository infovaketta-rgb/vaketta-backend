import { Request, Response } from "express";
export declare function createBooking(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function getBookings(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function updateBookingStatus(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function editBooking(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function getBookingSummary(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=booking.controller.d.ts.map