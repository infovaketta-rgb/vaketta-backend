import { Request, Response } from "express";
export declare function adminLogin(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function adminLogout(req: Request, res: Response): Promise<void>;
export declare function getMeHandler(req: Request, res: Response): Promise<void>;
export declare function createHotelHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function listHotelsHandler(req: Request, res: Response): Promise<void>;
export declare function getHotelHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateHotelHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteHotelHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function listAdminsHandler(_req: Request, res: Response): Promise<void>;
export declare function createAdminHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteAdminHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateSettingsHandler(req: Request, res: Response): Promise<void>;
export declare function createHotelUserHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateHotelUserHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteHotelUserHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=hotel.controller.d.ts.map