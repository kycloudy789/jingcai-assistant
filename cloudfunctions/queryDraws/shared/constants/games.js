/**
 * 彩种常量。所有模块只允许通过本文件引用彩种标识，禁止散落字符串。
 * 期号一律为字符串（禁止转数字比较）。
 */

const GAME = {
  SSQ: 'ssq',
  KL8: 'kl8',
};

const GAME_META = {
  [GAME.SSQ]: {
    game: GAME.SSQ,
    name: '双色球',
    shortName: '双色球',
    playType: 'single',
    redMin: 1,
    redMax: 33,
    redCount: 6,
    blueMin: 1,
    blueMax: 16,
    drawCount: 7, // 6 红 + 1 蓝
    displayOrder: 1,
  },
  [GAME.KL8]: {
    game: GAME.KL8,
    name: '快乐8（选十）',
    shortName: '快乐8',
    playType: 'choose10',
    min: 1,
    max: 80,
    count: 10,
    drawCount: 20,
    displayOrder: 2,
  },
};

/** 官方开奖公告列表页（主数据源，见 docs/data-source-plan.md） */
const SOURCE_URL = {
  [GAME.SSQ]: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
  [GAME.KL8]: 'https://www.cwl.gov.cn/ygkj/wqkjgg/kl8/',
};

/** 记录与核对状态枚举 */
const PURCHASE_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  VOID: 'void',
};

const DRAW_STATUS = {
  PENDING: 'pending',
  PARSED: 'parsed',
  CONFLICT: 'conflict',
  VERIFIED: 'verified',
  CORRECTED: 'corrected',
};

const SPECIAL_RULE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
};

/** 合规闸门默认值：一律关闭（见 docs/compliance-checklist.md） */
const DEFAULT_FEATURE_FLAGS = {
  wxComplianceStatus: 'not_checked', // not_checked | pending | approved | rejected
  candidateGenerationEnabled: false,
  aiFutureNumberFeatureEnabled: false,
  productionFeaturePolicy: 'compliance-gated',
};

const DISCLAIMER =
  '本工具用于个人记录和娱乐数据分析；不提供官方预测或购彩服务；历史数据不代表未来结果。中奖以官方销售终端打印的彩票及法定兑奖机构认定为准。';

function isGame(game) {
  return game === GAME.SSQ || game === GAME.KL8;
}

module.exports = {
  GAME,
  GAME_META,
  SOURCE_URL,
  PURCHASE_STATUS,
  DRAW_STATUS,
  SPECIAL_RULE_STATUS,
  DEFAULT_FEATURE_FLAGS,
  DISCLAIMER,
  isGame,
};
