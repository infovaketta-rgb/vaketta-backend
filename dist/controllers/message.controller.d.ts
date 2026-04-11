import { Request, Response } from "express";
export declare function manualReply(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function getMessages(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
/*** POST /messages/:guestId/read*/
export declare function markMessagesRead(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
/** PATCH /messages/:guestId/bot — toggle bot on/off for a guest */
export declare function setBotEnabled(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
/** POST /messages/send-media — staff sends a media file to a guest */
export declare function sendMedia(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=message.controller.d.ts.map