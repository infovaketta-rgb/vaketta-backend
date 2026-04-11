"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPlan = createPlan;
exports.getPlans = getPlans;
exports.getPlanById = getPlanById;
exports.updatePlan = updatePlan;
const connect_1 = __importDefault(require("../db/connect"));
async function createPlan(data) {
    return connect_1.default.plan.create({ data });
}
async function getPlans(includeInactive = false) {
    return connect_1.default.plan.findMany({
        where: includeInactive ? {} : { isActive: true },
        include: { _count: { select: { hotels: true } } },
        orderBy: { priceMonthly: "asc" },
    });
}
async function getPlanById(id) {
    return connect_1.default.plan.findUnique({ where: { id } });
}
async function updatePlan(id, data) {
    return connect_1.default.plan.update({ where: { id }, data });
}
//# sourceMappingURL=plan.service.js.map