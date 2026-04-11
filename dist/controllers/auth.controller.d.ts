import { Request, Response } from "express";
export declare function login(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function getUsers(req: Request, res: Response): Promise<void>;
export declare function createUser(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function logout(req: Request, res: Response): Promise<void>;
export declare function changePassword(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=auth.controller.d.ts.map