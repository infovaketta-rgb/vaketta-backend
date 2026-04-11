export type JwtPayload = {
    jti: string;
    id: string;
    role: string;
    hotelId: string;
    iat: number;
    exp: number;
};
export declare function signToken(payload: {
    id: string;
    role: string;
    hotelId: string;
}): string;
export declare function verifyToken(token: string): JwtPayload;
//# sourceMappingURL=jwt.d.ts.map