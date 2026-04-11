import { Request, Response } from "express";
export declare function listPlans(req: Request, res: Response): Promise<void>;
export declare function createPlanHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updatePlanHandler(req: Request, res: Response): Promise<void>;
export declare function assignPlanHandler(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function startTrialHandler(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=plan.controller.d.ts.map