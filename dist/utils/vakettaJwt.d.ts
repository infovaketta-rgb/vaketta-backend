export type VakettaAdminPayload = {
    jti: string;
    id: string;
    email: string;
    name: string;
    type: "vaketta_admin";
    iat: number;
    exp: number;
};
export declare function signVakettaToken(payload: {
    id: string;
    email: string;
    name: string;
}): string;
export declare function verifyVakettaToken(token: string): VakettaAdminPayload;
//# sourceMappingURL=vakettaJwt.d.ts.map