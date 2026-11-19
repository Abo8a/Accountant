// Интерактивные анкеты полей паспорта: таблица со строками, выбор «да/нет», отметки и короткие поля вместо сплошного текста.
// Форма превращается в связный текст (toText) — его проверяет ИИ, размечает утверждения аудит и печатает DOCX.
// Сама форма хранится рядом с текстом (form_data), потому что ИИ переписывает ответ своими словами.
// Новый элемент: макета в дизайне нет (решение владельца), вопросы и примеры — из базы знаний программы.

export type Row = Record<string, string>;

export interface FormValue {
  choice?: string;
  flags?: string[];
  inputs?: Record<string, string>;
  rows?: Row[];
  text?: string;
}

export interface FormCtx {
  /** Имена участников из анкеты «Состав команды» — для опыта команды и авторов. */
  team: string[];
}

export interface Column {
  key: string;
  label: string;
  placeholder?: string;
  /** Выбор из списка вместо ввода. */
  options?: string[];
  optional?: boolean;
  wide?: boolean;
  /** Проверка значения: текст ошибки или null. */
  check?: (value: string) => string | null;
}

type When = (v: FormValue) => boolean;

export interface FieldFormSpec {
  choice?: { label: string; options: string[] };
  flags?: { label: string; options: (ctx: FormCtx) => string[]; when?: When; minPicked?: number };
  inputs?: { columns: Column[]; when?: When };
  rows?: { label?: string; columns: Column[]; minRows: number; addLabel: string; when?: When; seed?: (ctx: FormCtx) => Row[] };
  text?: { label: string; placeholder?: string; when?: When; optional?: boolean };
  /** Связный текст поля из заполненной формы. */
  toText: (v: Required<FormValue>) => string;
  /** Дополнительная проверка формы целиком. */
  check?: (v: Required<FormValue>) => string | null;
}

/** Без завершающих знаков, чтобы не было «..» в собранном тексте; точку после инициала («И. И.») и сокращения («т. д.») не трогаем. */
const dot = (s: string) => {
  const t = s.trim().replace(/[;,]+$/, '');
  return /(^|[\s.])([A-ZА-ЯЁ]|т\. ?[дп]|др)\.$/.test(t) ? t : t.replace(/\.+$/, '');
};

function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

/** «1», «1–2», «3-6» → [начало, конец]; иначе null. */
function parseMonths(value: string): [number, number] | null {
  const m = value.trim().match(/^(\d{1,2})\s*(?:[–—-]\s*(\d{1,2}))?$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from <= to ? [from, to] : null;
}

function monthsCheck(min: number, max: number) {
  return (value: string) => {
    const r = parseMonths(value);
    if (!r) return `месяцы укажите числом или диапазоном, например ${min} или ${min}–${max}`;
    if (r[0] < min || r[1] > max) return `этап длится с ${min}-го по ${max}-й месяц`;
    return null;
  };
}

function monthsLabel(value: string): string {
  const [from, to] = parseMonths(value)!;
  return from === to ? `Месяц ${from}` : `Месяцы ${from}–${to}`;
}

const digits = (counts: number[]) => (value: string) =>
  /^\d+$/.test(value.trim()) && counts.includes(value.trim().length) ? null : `${counts.join(' или ')} цифр`;

const year = (value: string) => (/^(19|20)\d{2}$/.test(value.trim()) ? null : 'год — четыре цифры, например 2025');

const list = (items: string[]) => items.map((i) => `— ${i}`).join('\n');

const calendar = (min: number, max: number): FieldFormSpec => ({
  rows: {
    columns: [
      { key: 'months', label: 'Месяцы', placeholder: min === 1 ? '1 или 1–2' : '3–6', check: monthsCheck(min, max) },
      { key: 'work', label: 'Работа', placeholder: min === 1 ? '20 интервью со студентами' : 'запуск сервиса для двух вузов', wide: true },
      { key: 'result', label: 'Измеримый результат', placeholder: min === 1 ? 'отчёт по 20 интервью' : '500 поездок, отчёт по гипотезе', wide: true },
    ],
    minRows: 1,
    addLabel: 'Добавить работу',
  },
  toText: (v) => v.rows.map((r) => `${monthsLabel(r.months!)}: ${dot(r.work!)}; результат — ${dot(r.result!)}.`).join('\n'),
});

const NO_LEGAL = 'Нет, создадим ООО при победе';

export const FIELD_FORMS: Record<string, FieldFormSpec> = {
  '2/team_members': {
    rows: {
      columns: [
        { key: 'name', label: 'ФИО', placeholder: 'Иван Иванов' },
        { key: 'role', label: 'Роль в проекте', placeholder: 'разработка, backend', wide: true },
      ],
      minRows: 1,
      addLabel: 'Добавить участника',
    },
    toText: (v) =>
      `В команде ${v.rows.length} ${plural(v.rows.length, ['человек', 'человека', 'человек'])}: ${v.rows.map((r) => `${dot(r.name!)} (${dot(r.role!)})`).join(', ')}.`,
  },

  '2/competencies_and_experience': {
    rows: {
      columns: [
        { key: 'name', label: 'Участник', placeholder: 'Иван Иванов' },
        { key: 'experience', label: 'Опыт и компетенции', placeholder: 'разработка на React в 2 учебных проектах', wide: true },
      ],
      minRows: 1,
      addLabel: 'Добавить участника',
      seed: (ctx) => ctx.team.map((name) => ({ name, experience: '' })),
    },
    toText: (v) => v.rows.map((r) => `${dot(r.name!)}: ${dot(r.experience!)}.`).join('\n'),
  },

  '4/core_features': {
    rows: {
      columns: [{ key: 'feature', label: 'Функция', placeholder: 'подбор попутчиков по маршруту', wide: true }],
      minRows: 1,
      addLabel: 'Добавить функцию',
    },
    toText: (v) => `Ключевые функции:\n${list(v.rows.map((r) => dot(r.feature!)))}`,
  },

  '4/tech_approach': {
    rows: {
      columns: [
        { key: 'part', label: 'Часть системы', placeholder: 'клиент, сервер, база данных' },
        { key: 'tech', label: 'Технологии', placeholder: 'React', wide: true },
      ],
      minRows: 1,
      addLabel: 'Добавить часть',
    },
    toText: (v) => v.rows.map((r) => `${dot(r.part!)}: ${dot(r.tech!)}.`).join('\n'),
  },

  '5/current_stage': {
    choice: { label: 'Стадия', options: ['Идея', 'Прототип', 'MVP'] },
    text: { label: 'Что уже сделано и работает', placeholder: 'работает поиск попутчиков на тестовых данных', optional: true },
    check: (v) => (v.choice !== 'Идея' && !v.text ? 'Опишите, что уже сделано и работает.' : null),
    toText: (v) => (v.text ? `${v.choice}: ${dot(v.text)}.` : `${v.choice}.`),
  },

  '5/existing_backlog_and_mvp': {
    rows: {
      columns: [
        { key: 'feature', label: 'Функция', placeholder: 'регистрация через университетскую почту', wide: true },
        { key: 'status', label: 'Статус', options: ['работает на реальных данных', 'работает на тестовых данных', 'в разработке'] },
      ],
      minRows: 1,
      addLabel: 'Добавить функцию',
    },
    text: { label: 'Дополнительно', placeholder: 'версия, где и на ком тестировали', optional: true },
    toText: (v) => `Функции MVP:\n${list(v.rows.map((r) => `${dot(r.feature!)} — ${r.status}`))}${v.text ? `\n${v.text.trim()}` : ''}`,
  },

  '5/calendar_plan_stage_1': calendar(1, 2),
  '5/calendar_plan_stage_2': calendar(3, 12),

  '6/analogues_comparison': {
    rows: {
      columns: [
        { key: 'name', label: 'Аналог', placeholder: 'BlaBlaCar' },
        { key: 'how', label: 'Как устроен, чего не хватает', placeholder: 'проверка через соцсети, нет фильтра по вузу', wide: true },
        { key: 'diff', label: 'Наше отличие', placeholder: 'проверка через университетскую почту', wide: true },
      ],
      minRows: 2,
      addLabel: 'Добавить аналог',
    },
    toText: (v) => v.rows.map((r, i) => `Аналог ${i + 1}: ${dot(r.name!)} — ${dot(r.how!)}. Наше отличие: ${dot(r.diff!)}.`).join('\n'),
  },

  '7/market_overview': {
    inputs: {
      columns: [
        { key: 'segment', label: 'Сегмент', placeholder: 'студенты очных программ вузов региона', wide: true },
        { key: 'size', label: 'Размер', placeholder: 'около 40 000 человек' },
        { key: 'source', label: 'Источник цифр', placeholder: 'пусто — оценка команды', optional: true },
      ],
    },
    text: { label: 'Дополнительно', placeholder: 'динамика, смежные сегменты', optional: true },
    toText: (v) => {
      const i = v.inputs;
      const source = i.source?.trim() ? ` по данным: ${dot(i.source)}.` : ' (оценка команды).';
      return `${dot(i.segment!)} — ${dot(i.size!)}${source}${v.text ? `\n${v.text.trim()}` : ''}`;
    },
  },

  '7/business_model_and_pricing': {
    flags: { label: 'Кто платит', options: () => ['B2C — пользователи', 'B2B — компании', 'B2G — государство', 'Пилоты и заказная разработка'], minPicked: 1 },
    text: { label: 'Как зарабатываем и сколько стоит', placeholder: 'бесплатно для студентов, подписка для вузов от 15 000 ₽ в месяц' },
    toText: (v) => `Модель: ${v.flags.join(', ')}.\n${v.text.trim()}`,
  },

  '7/traction_and_pilots': {
    choice: { label: 'Пилоты, фокус-группы, продажи', options: ['Есть или запланированы', 'Пока нет'] },
    rows: {
      when: (v) => v.choice === 'Есть или запланированы',
      columns: [
        { key: 'event', label: 'Что', placeholder: '2 фокус-группы, 12 человек', wide: true },
        { key: 'date', label: 'Когда', placeholder: 'февраль 2026' },
        { key: 'kind', label: 'Статус', options: ['Сделано', 'В планах'] },
      ],
      minRows: 1,
      addLabel: 'Добавить запись',
    },
    toText: (v) => {
      if (v.choice === 'Пока нет') return 'Пилотов, фокус-групп и продаж пока нет.';
      const part = (kind: string, title: string) => {
        const items = v.rows.filter((r) => r.kind === kind).map((r) => `${dot(r.event!)} (${dot(r.date!)})`);
        return items.length ? `${title}:\n${list(items)}` : '';
      };
      return [part('Сделано', 'Сделано'), part('В планах', 'В планах')].filter(Boolean).join('\n');
    },
  },

  '8/legal_entity_info': {
    choice: { label: 'Юридическое лицо', options: [NO_LEGAL, 'ООО', 'ИП'] },
    inputs: {
      when: (v) => !!v.choice && v.choice !== NO_LEGAL,
      columns: [
        { key: 'name', label: 'Название', placeholder: 'ООО «Попутчик» или ИП Иванов И. И.', wide: true },
        { key: 'inn', label: 'ИНН', placeholder: '10 или 12 цифр', check: digits([10, 12]) },
        { key: 'ogrn', label: 'ОГРН / ОГРНИП', placeholder: '13 или 15 цифр', check: digits([13, 15]) },
      ],
    },
    toText: (v) => {
      if (v.choice === NO_LEGAL) return 'Юрлицо не создано; будет создано ООО при победе в конкурсе.';
      const i = v.inputs;
      const form = v.choice === 'ООО' ? 'ООО' : 'ИП';
      const name = dot(i.name!).startsWith(form) ? dot(i.name!) : `${form} ${dot(i.name!)}`;
      return `${name}, ИНН ${i.inn!.trim()}, ${form === 'ООО' ? 'ОГРН' : 'ОГРНИП'} ${i.ogrn!.trim()}.`;
    },
  },

  '8/entity_roles': {
    rows: {
      columns: [
        { key: 'who', label: 'Организация или человек', placeholder: 'Иван Иванов', wide: true },
        {
          key: 'role',
          label: 'Роль',
          options: ['заявитель', 'получатель гранта', 'правообладатель', 'заявитель и получатель', 'получатель и правообладатель', 'заявитель, получатель и правообладатель'],
        },
      ],
      minRows: 1,
      addLabel: 'Добавить участника',
    },
    toText: (v) => v.rows.map((r) => `${dot(r.who!)} — ${r.role}.`).join('\n'),
  },

  '9/ip_rights_and_authors': {
    flags: { label: 'Авторы из команды', options: (ctx) => ctx.team },
    inputs: {
      columns: [
        { key: 'others', label: 'Другие авторы', placeholder: 'через запятую', optional: true, wide: true },
        { key: 'owner', label: 'Правообладатель', placeholder: 'авторы до регистрации ООО', wide: true },
      ],
    },
    check: (v) => (v.flags.length === 0 && !v.inputs.others?.trim() ? 'Укажите хотя бы одного автора.' : null),
    toText: (v) => {
      const authors = [...v.flags, ...(v.inputs.others ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
      return `Авторы — ${authors.join(', ')}. Правообладатель: ${dot(v.inputs.owner!)}.`;
    },
  },

  '9/rid_certificates': {
    choice: { label: 'Свидетельства Роспатента (РИД)', options: ['Нет', 'Есть'] },
    flags: { label: 'Планы', options: () => ['Планируем подать заявку'], when: (v) => v.choice === 'Нет' },
    rows: {
      when: (v) => v.choice === 'Есть',
      columns: [
        { key: 'type', label: 'Что зарегистрировано', options: ['Программа для ЭВМ', 'База данных', 'Изобретение', 'Полезная модель', 'Другое'] },
        { key: 'number', label: 'Номер', placeholder: '2026612345' },
        { key: 'date', label: 'Дата', placeholder: '12.03.2026' },
      ],
      minRows: 1,
      addLabel: 'Добавить свидетельство',
    },
    toText: (v) => {
      if (v.choice === 'Нет') return v.flags.length ? 'Свидетельств РИД нет; подача заявки запланирована.' : 'Свидетельств РИД нет.';
      return v.rows.map((r) => `${r.type}: свидетельство № ${r.number!.trim()} от ${dot(r.date!)}.`).join('\n');
    },
  },

  '10/previous_grants_and_statuses': {
    choice: { label: 'Гранты, статусы и другая поддержка', options: ['Не получали', 'Получали'] },
    rows: {
      when: (v) => v.choice === 'Получали',
      columns: [
        { key: 'kind', label: 'Что', options: ['Грант ФСИ', 'Статус участника Сколково', 'Другой грант', 'Другая поддержка'] },
        { key: 'name', label: 'Программа или название', placeholder: 'УМНИК', optional: true, wide: true },
        { key: 'year', label: 'Год', placeholder: '2025', check: year },
      ],
      minRows: 1,
      addLabel: 'Добавить запись',
    },
    toText: (v) =>
      v.choice === 'Не получали'
        ? 'Ранее грантов, статусов и другой поддержки не получали.'
        : v.rows.map((r) => `${r.kind}${r.name?.trim() ? ` («${dot(r.name)}»)` : ''}, ${r.year!.trim()}.`).join('\n'),
  },

  '10/active_obligations': {
    choice: { label: 'Открытые договоры и обязательства', options: ['Нет', 'Есть'] },
    text: { label: 'Какие обязательства', placeholder: 'договор НИОКР с вузом до декабря 2026', when: (v) => v.choice === 'Есть' },
    toText: (v) => (v.choice === 'Нет' ? 'Открытых договоров и обязательств нет.' : `Открытые обязательства: ${v.text.trim()}`),
  },
};

const active = (part: { when?: When } | undefined, v: FormValue) => !!part && (!part.when || part.when(v));
const filledRow = (r: Row) => Object.values(r).some((x) => x.trim());

/** Пустая форма: строки таблицы — из команды (если есть) или пустые до минимума. */
export function emptyForm(spec: FieldFormSpec, ctx: FormCtx): FormValue {
  const seeded = spec.rows?.seed?.(ctx) ?? [];
  const rows = seeded.length ? seeded : Array.from({ length: Math.max(1, spec.rows?.minRows ?? 1) }, () => ({}) as Row);
  return { choice: undefined, flags: [], inputs: {}, rows: spec.rows ? rows : [], text: '' };
}

/** Форма из сохранённых данных (form_data); чужая форма (другие ключи) — null. */
export function formFromData(spec: FieldFormSpec, data: unknown): FormValue | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as FormValue;
  if (spec.choice && d.choice && !spec.choice.options.includes(d.choice)) return null;
  return {
    choice: typeof d.choice === 'string' ? d.choice : undefined,
    flags: Array.isArray(d.flags) ? d.flags.filter((x) => typeof x === 'string') : [],
    inputs: d.inputs && typeof d.inputs === 'object' ? { ...d.inputs } : {},
    rows: Array.isArray(d.rows) && d.rows.length ? d.rows.map((r) => ({ ...r })) : spec.rows ? [{}] : [],
    text: typeof d.text === 'string' ? d.text : '',
  };
}

/** Заполненная часть формы: только показанные части, без пустых строк и пробелов по краям. */
export function cleanForm(spec: FieldFormSpec, v: FormValue, ctx: FormCtx): Required<FormValue> {
  const trimRow = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, (x ?? '').trim()]));
  const flagOptions = spec.flags ? spec.flags.options(ctx) : [];
  return {
    choice: spec.choice ? (v.choice ?? '') : '',
    flags: active(spec.flags, v) ? (v.flags ?? []).filter((f) => flagOptions.includes(f)) : [],
    inputs: active(spec.inputs, v) ? trimRow(v.inputs ?? {}) : {},
    rows: active(spec.rows, v) ? (v.rows ?? []).map(trimRow).filter(filledRow) : [],
    text: active(spec.text, v) ? (v.text ?? '').trim() : '',
  };
}

/** Первая ошибка заполнения или null. */
export function validateForm(spec: FieldFormSpec, v: FormValue, ctx: FormCtx): string | null {
  const c = cleanForm(spec, v, ctx);
  if (spec.choice && !c.choice) return `Выберите вариант: «${spec.choice.label}».`;
  if (active(spec.flags, v) && spec.flags!.minPicked && c.flags.length < spec.flags!.minPicked) {
    return `Отметьте хотя бы один вариант: «${spec.flags!.label}».`;
  }
  if (active(spec.inputs, v)) {
    for (const col of spec.inputs!.columns) {
      const value = c.inputs[col.key] ?? '';
      if (!value && !col.optional) return `Заполните поле «${col.label}».`;
      const err = value && col.check?.(value);
      if (err) return `«${col.label}»: ${err}.`;
    }
  }
  if (active(spec.rows, v)) {
    const { minRows, columns } = spec.rows!;
    if (c.rows.length < minRows) return `Нужно строк: не меньше ${minRows}.`;
    for (const [i, row] of c.rows.entries()) {
      for (const col of columns) {
        const value = row[col.key] ?? '';
        if (!value && !col.optional) return `Строка ${i + 1}: заполните «${col.label}».`;
        if (value && col.options && !col.options.includes(value)) return `Строка ${i + 1}: выберите «${col.label}» из списка.`;
        const err = value && col.check?.(value);
        if (err) return `Строка ${i + 1}, «${col.label}»: ${err}.`;
      }
    }
  }
  if (active(spec.text, v) && !spec.text!.optional && !c.text) return `Заполните поле «${spec.text!.label}».`;
  return spec.check?.(c) ?? null;
}

/** Текст поля и данные формы для сохранения; ошибка — если форма заполнена не до конца. */
export function formToSave(spec: FieldFormSpec, v: FormValue, ctx: FormCtx): { ok: true; text: string; data: Record<string, unknown> } | { ok: false; error: string } {
  const error = validateForm(spec, v, ctx);
  if (error) return { ok: false, error };
  const c = cleanForm(spec, v, ctx);
  return { ok: true, text: spec.toText(c), data: c as unknown as Record<string, unknown> };
}

/** Имена участников из сохранённой анкеты «Состав команды». */
export function teamFromData(data: unknown): string[] {
  const rows = (data as FormValue | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (typeof r?.name === 'string' ? r.name.trim() : '')).filter(Boolean);
}
