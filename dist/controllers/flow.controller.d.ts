import { Request, Response } from "express";
export declare function getHotelFlowsHandler(req: Request, res: Response): Promise<void>;
export declare function getHotelFlowHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function createHotelFlowHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateHotelFlowHandler(req: Request, res: Response): Promise<void>;
export declare function deleteHotelFlowHandler(req: Request, res: Response): Promise<void>;
export declare function adminListFlowsHandler(req: Request, res: Response): Promise<void>;
export declare function adminGetFlowHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function adminCreateFlowHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function adminUpdateFlowHandler(req: Request, res: Response): Promise<void>;
export declare function adminDeleteFlowHandler(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=flow.controller.d.ts.map