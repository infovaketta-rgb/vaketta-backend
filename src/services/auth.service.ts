import prisma from "../db/connect";
import { comparePassword, hashPassword } from "../utils/hash";
import { signToken } from "../utils/jwt";
import { UserRole } from "@prisma/client";

export async function loginService(email:string,password:string){

  const user = await prisma.user.findUnique({
    where:{ email },
    include:{ hotel:true }
  });

  if(!user) throw new Error("Invalid credentials");

  if(!user.isActive) throw new Error("Account is disabled. Contact your administrator.");

  const valid = await comparePassword(password,user.password);
  if(!valid) throw new Error("Invalid credentials");

  const token = signToken({
    id:user.id,
    role:user.role,
    hotelId:user.hotelId
  });

  const { password: _pw, ...safeUser } = user;
  return { token, user: safeUser };
}


export async function getUsersService(hotelId: string) {
  return prisma.user.findMany({
    where: { hotelId },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createUserService(data:{
  name:string;
  email:string;
  password:string;
  role:UserRole;
  hotelId:string;
}){

  const hashed = await hashPassword(data.password);

  const existing = await prisma.user.findUnique({
  where:{ email:data.email }
});

if(existing) throw new Error("Email already exists");


  return prisma.user.create({
    data:{ ...data, password: hashed },
    select: { id: true, name: true, email: true, role: true, hotelId: true, createdAt: true },
  });
}
