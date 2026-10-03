export const CATEGORIES = ['food', 'groceries', 'travel', 'rent', 'utilities', 'fun', 'other'];
export const CATEGORY_COLORS = {
  food: '#f59e0b', groceries: '#10b981', travel: '#3b82f6', rent: '#8b5cf6', utilities: '#06b6d4', fun: '#ec4899', other: '#94a3b8',
};
export const SPLIT_LABELS = { equal: 'Equally', exact: 'Exact amounts', percent: 'Percentages', shares: 'Shares' };

export const memberName = (group, id) => group.members.find((m) => String(m.userId) === String(id))?.name ?? 'Former member';

const IST = 5.5 * 3600 * 1000;
export const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
export const today = () => istDay(new Date());
export const thisMonth = () => today().slice(0, 7);
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
