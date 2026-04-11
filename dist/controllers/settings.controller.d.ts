import { Request, Response } from "express";
export declare function getSettings(req: Request, res: Response): Promise<void>;
export declare function patchSettings(req: Request, res: Response): Promise<void>;
export declare function getMenuHandler(req: Request, res: Response): Promise<void>;
export declare function addMenuItemHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateMenuItemHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteMenuItemHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateMenuTitleHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function patchBotMessages(req: Request, res: Response): Promise<void>;
export declare function testWhatsAppHandler(req: Request, res: Response): Promise<void>;
export declare function getWhatsAppHandler(req: Request, res: Response): Promise<void>;
export declare function patchWhatsAppHandler(req: Request, res: Response): Promise<void>;
export declare function patchHotelProfile(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=settings.controller.d.ts.map