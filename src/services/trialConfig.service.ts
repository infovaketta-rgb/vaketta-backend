import prisma from "../db/connect";

const SINGLETON_ID = "global";

export async function getTrialConfig() {
  return prisma.trialConfig.upsert({
    where:  { id: SINGLETON_ID },
    update: {},
    create: { id: SINGLETON_ID },
  });
}

export async function updateTrialConfig(data: {
  durationDays?:      number;
  conversationLimit?: number;
  aiReplyLimit?:      number;
  autoStartOnCreate?: boolean;
  trialMessage?:      string;
}) {
  return prisma.trialConfig.upsert({
    where:  { id: SINGLETON_ID },
    update: data,
    create: { id: SINGLETON_ID, ...data },
  });
}
