import { UserRole } from "@prisma/client";
export declare function loginService(email: string, password: string): Promise<{
    token: string;
    user: {
        hotel: {
            id: string;
            name: string;
            phone: string;
            apiKey: string | null;
            location: string | null;
            email: string | null;
            description: string | null;
            checkInTime: string;
            checkOutTime: string;
            website: string | null;
            subscriptionStatus: string;
            billingStartDate: Date | null;
            billingEndDate: Date | null;
            createdAt: Date;
            planId: string | null;
        };
        id: string;
        name: string;
        email: string;
        createdAt: Date;
        hotelId: string;
        role: import(".prisma/client").$Enums.UserRole;
        isActive: boolean;
    };
}>;
export declare function getUsersService(hotelId: string): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    role: import(".prisma/client").$Enums.UserRole;
    isActive: boolean;
}[]>;
export declare function createUserService(data: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
    hotelId: string;
}): Promise<{
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    hotelId: string;
    role: import(".prisma/client").$Enums.UserRole;
}>;
//# sourceMappingURL=auth.service.d.ts.map