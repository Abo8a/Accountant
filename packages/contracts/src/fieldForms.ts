// Устройство интерактивных анкет полей паспорта — только данные (без логики сборки текста).
// Нужно бэкенду: когда ИИ заполняет паспорт из брифа или документов, он раскладывает текст поля по анкете
// (выбор «да/нет», строки таблицы, отметки), чтобы в кабинете открывалась заполненная анкета, а не пустая.
// Логика анкет (сборка текста, проверки) — во фронтенде: frontend/src/features/passport/forms/schemas.ts.
// Тест фронтенда сверяет оба описания: варианты выбора, колонки и отметки должны совпадать.

export interface FieldFormColumnShape {
  key: string;
  label: string;
  /** Значение только из списка. */
  options?: string[];
  optional?: boolean;
}

export interface FieldFormShape {
  choice?: { label: string; options: string[] };
  /** options: 'team' — имена участников из анкеты «Состав команды». */
  flags?: { label: string; options: string[] | 'team' };
  inputs?: { columns: FieldFormColumnShape[] };
  rows?: { columns: FieldFormColumnShape[] };
  text?: { label: string };
  /** Когда какие части анкеты заполняются (для модели). */
  note?: string;
}

export const NO_LEGAL_ENTITY = 'Нет, создадим ООО при победе';

const calendarRows = (from: number, to: number): FieldFormShape => ({
  rows: {
    columns: [
      { key: 'months', label: `Месяцы (с ${from}-го по ${to}-й)` },
      { key: 'work', label: 'Работа' },
      { key: 'result', label: 'Измеримый результат' },
    ],
  },
  note: `months — число или диапазон месяцев в пределах этапа (с ${from}-го по ${to}-й), например «${from}» или «${from}–${to}».`,
});

export const FIELD_FORM_SHAPES: Record<string, FieldFormShape> = {
  '2/team_members': {
    rows: { columns: [{ key: 'name', label: 'ФИО' }, { key: 'role', label: 'Роль в проекте' }] },
  },
  '2/competencies_and_experience': {
    rows: { columns: [{ key: 'name', label: 'Участник' }, { key: 'experience', label: 'Опыт и компетенции' }] },
  },
  '4/core_features': {
    rows: { columns: [{ key: 'feature', label: 'Функция' }] },
  },
  '4/tech_approach': {
    rows: { columns: [{ key: 'part', label: 'Часть системы' }, { key: 'tech', label: 'Технологии' }] },
  },
  '5/current_stage': {
    choice: { label: 'Стадия', options: ['Идея', 'Прототип', 'MVP'] },
    text: { label: 'Что уже сделано и работает' },
  },
  '5/existing_backlog_and_mvp': {
    rows: {
      columns: [
        { key: 'feature', label: 'Функция' },
        { key: 'status', label: 'Статус', options: ['работает на реальных данных', 'работает на тестовых данных', 'в разработке'] },
      ],
    },
    text: { label: 'Дополнительно' },
  },
  '5/calendar_plan_stage_1': calendarRows(1, 2),
  '5/calendar_plan_stage_2': calendarRows(3, 12),
  '6/analogues_comparison': {
    rows: {
      columns: [
        { key: 'name', label: 'Аналог' },
        { key: 'how', label: 'Как устроен, чего не хватает' },
        { key: 'diff', label: 'Наше отличие' },
      ],
    },
  },
  '7/market_overview': {
    inputs: {
      columns: [
        { key: 'segment', label: 'Сегмент' },
        { key: 'size', label: 'Размер' },
        { key: 'source', label: 'Источник цифр', optional: true },
      ],
    },
    text: { label: 'Дополнительно' },
  },
  '7/business_model_and_pricing': {
    flags: { label: 'Кто платит', options: ['B2C — пользователи', 'B2B — компании', 'B2G — государство', 'Пилоты и заказная разработка'] },
    text: { label: 'Как зарабатываем и сколько стоит' },
  },
  '7/traction_and_pilots': {
    choice: { label: 'Пилоты, фокус-группы, продажи', options: ['Есть или запланированы', 'Пока нет'] },
    rows: {
      columns: [
        { key: 'event', label: 'Что' },
        { key: 'date', label: 'Когда' },
        { key: 'kind', label: 'Статус', options: ['Сделано', 'В планах'] },
      ],
    },
    note: 'rows — только если выбрано «Есть или запланированы».',
  },
  '8/legal_entity_info': {
    choice: { label: 'Юридическое лицо', options: [NO_LEGAL_ENTITY, 'ООО', 'ИП'] },
    inputs: {
      columns: [
        { key: 'name', label: 'Название' },
        { key: 'inn', label: 'ИНН' },
        { key: 'ogrn', label: 'ОГРН / ОГРНИП' },
      ],
    },
    note: 'inputs — только если выбрано «ООО» или «ИП».',
  },
  '8/entity_roles': {
    rows: {
      columns: [
        { key: 'who', label: 'Организация или человек' },
        {
          key: 'role',
          label: 'Роль',
          options: ['заявитель', 'получатель гранта', 'правообладатель', 'заявитель и получатель', 'получатель и правообладатель', 'заявитель, получатель и правообладатель'],
        },
      ],
    },
  },
  '9/ip_rights_and_authors': {
    flags: { label: 'Авторы из команды', options: 'team' },
    inputs: {
      columns: [
        { key: 'others', label: 'Другие авторы', optional: true },
        { key: 'owner', label: 'Правообладатель' },
      ],
    },
    note: 'flags — имена авторов из состава команды; авторы не из команды — в inputs.others через запятую.',
  },
  '9/rid_certificates': {
    choice: { label: 'Свидетельства Роспатента (РИД)', options: ['Нет', 'Есть'] },
    flags: { label: 'Планы', options: ['Планируем подать заявку'] },
    rows: {
      columns: [
        { key: 'type', label: 'Что зарегистрировано', options: ['Программа для ЭВМ', 'База данных', 'Изобретение', 'Полезная модель', 'Другое'] },
        { key: 'number', label: 'Номер' },
        { key: 'date', label: 'Дата' },
      ],
    },
    note: 'flags — только если выбрано «Нет»; rows — только если «Есть».',
  },
  '10/previous_grants_and_statuses': {
    choice: { label: 'Гранты, статусы и другая поддержка', options: ['Не получали', 'Получали'] },
    rows: {
      columns: [
        { key: 'kind', label: 'Что', options: ['Грант ФСИ', 'Статус участника Сколково', 'Другой грант', 'Другая поддержка'] },
        { key: 'name', label: 'Программа или название', optional: true },
        { key: 'year', label: 'Год' },
      ],
    },
    note: 'rows — только если выбрано «Получали».',
  },
  '10/active_obligations': {
    choice: { label: 'Открытые договоры и обязательства', options: ['Нет', 'Есть'] },
    text: { label: 'Какие обязательства' },
    note: 'text — только если выбрано «Есть».',
  },
};

/** Данные анкеты (form_data): те же ключи, что у формы во фронтенде. */
export interface FieldFormData {
  choice: string;
  flags: string[];
  inputs: Record<string, string>;
  rows: Record<string, string>[];
  text: string;
}

const MAX_ROWS = 30;
const MAX_CELL = 2_000;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_CELL) : '');

/**
 * Приводит ответ модели к анкете: только известные ключи и колонки, варианты — только из списка.
 * Выбор не из списка = анкета не заполнена (null): лучше пустая анкета, чем неверная.
 * team — имена участников (для отметок «Авторы из команды»).
 */
export function sanitizeFieldForm(shape: FieldFormShape, raw: unknown, team: readonly string[] = []): FieldFormData | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const choice = str(d.choice);
  if (shape.choice && !shape.choice.options.includes(choice)) return null;

  const flagOptions = shape.flags ? (shape.flags.options === 'team' ? team : shape.flags.options) : [];
  const flags = Array.isArray(d.flags) ? [...new Set(d.flags.map(str).filter((f) => flagOptions.includes(f)))] : [];

  const pick = (cols: FieldFormColumnShape[], src: unknown): Record<string, string> => {
    const o = src && typeof src === 'object' ? (src as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const c of cols) {
      const v = str(o[c.key]);
      out[c.key] = c.options && !c.options.includes(v) ? '' : v;
    }
    return out;
  };
  const inputs = shape.inputs ? pick(shape.inputs.columns, d.inputs) : {};
  const rows =
    shape.rows && Array.isArray(d.rows)
      ? d.rows
          .slice(0, MAX_ROWS)
          .map((r) => pick(shape.rows!.columns, r))
          .filter((r) => Object.values(r).some(Boolean))
      : [];
  const text = shape.text ? str(d.text) : '';

  const empty = !choice && flags.length === 0 && !Object.values(inputs).some(Boolean) && rows.length === 0 && !text;
  return empty ? null : { choice, flags, inputs, rows, text };
}
