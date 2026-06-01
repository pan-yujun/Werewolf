import type { Persona, PlayerMind } from "@/types/game";

export interface GeneratedCharacter {
  displayName: string;
  persona: Persona;
  playerMind?: PlayerMind;
  avatarSeed?: string;
}

/**
 * 内置角色配置
 * 当 LLM 生成角色失败时，使用这些预设角色作为备用方案
 */

// ============ 名字配置 ============
export const BUILTIN_MALE_NAMES = [
  "张伟", "李强", "王刚", "刘明", "陈勇",
  "赵磊", "周军", "吴涛", "孙健",
];

export const BUILTIN_FEMALE_NAMES = [
  "王芳", "李娜", "张敏", "刘丽", "陈静",
  "赵雪", "周婷", "吴玲", "孙慧",
];

// ============ MBTI 配置 ============
export const BUILTIN_MBTI = [
  "ISTJ", "ISFJ", "INFJ", "INTJ",
  "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP",
  "ESTJ", "ESFJ", "ENFJ", "ENTJ",
];

// ============ 职业配置 ============
export const BUILTIN_MALE_OCCUPATIONS = [
  "开出租的老司机",
  "刚升职的部门经理",
  "开了十年的厨师",
  "社区诊所的医生",
  "快递站的老员工",
  "五金店老板",
  "修车铺的师傅",
  "批发市场的小老板",
  "物业公司的保安队长",
];

export const BUILTIN_FEMALE_OCCUPATIONS = [
  "小学班主任",
  "超市收银员",
  "花店老板娘",
  "社区护士",
  "公司财务",
  "幼儿园老师",
  "服装店导购",
  "银行柜员",
  "美甲店老板",
];

// ============ 默认 Persona 配置 ============
export const DEFAULT_VOICE_RULES: string[] = ["说话自然", "语气友好"];

// ============ 默认 PlayerMind 配置 ============
export const DEFAULT_PLAYER_MIND: PlayerMind = {
  courage: "中等",
  memoryBias: "关注近期发言",
  suspicionThreshold: "中等",
  selfProtection: "适度自保",
  logicDepth: "基础逻辑",
  tablePresence: "积极参与",
};

// ============ 内置角色生成函数 ============
function generateSingleBuiltinCharacter(
  index: number,
  gender: "male" | "female",
  age: number,
  mbti: string
): GeneratedCharacter {
  const names = gender === "male" ? BUILTIN_MALE_NAMES : BUILTIN_FEMALE_NAMES;
  const occupations = gender === "male" ? BUILTIN_MALE_OCCUPATIONS : BUILTIN_FEMALE_OCCUPATIONS;
  const name = names[index % names.length];
  const occupation = occupations[index % occupations.length];

  return {
    displayName: name,
    persona: {
      gender,
      age,
      mbti,
      voiceRules: [...DEFAULT_VOICE_RULES],
    },
    playerMind: { ...DEFAULT_PLAYER_MIND },
  };
}

/**
 * 生成指定数量的内置角色
 * @param count 需要生成的角色数量
 * @returns 内置角色数组
 */
export function generateBuiltinCharacters(count: number): GeneratedCharacter[] {
  const characters: GeneratedCharacter[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    const gender: "male" | "female" = i % 2 === 0 ? "male" : "female";
    const age = 25 + Math.floor(Math.random() * 25); // 25-50
    const mbti = BUILTIN_MBTI[i % BUILTIN_MBTI.length];

    let character = generateSingleBuiltinCharacter(i, gender, age, mbti);

    // 确保名字唯一
    let attempts = 0;
    while (usedNames.has(character.displayName) && attempts < 20) {
      attempts++;
      const nameList = gender === "male" ? BUILTIN_MALE_NAMES : BUILTIN_FEMALE_NAMES;
      character.displayName = nameList[(i + attempts) % nameList.length];
    }
    usedNames.add(character.displayName);

    characters.push(character);
  }

  return characters;
}
