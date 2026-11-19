import { describe, expect, it } from 'vitest';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { emptyForm, FIELD_FORMS, formFromData, formToSave, teamFromData, validateForm, type FormValue } from './schemas';

const ctx = { team: ['Иван Иванов', 'Мария Петрова'] };
const save = (key: string, v: FormValue) => formToSave(FIELD_FORMS[key]!, v, ctx);
const text = (key: string, v: FormValue) => {
  const res = save(key, v);
  if (!res.ok) throw new Error(res.error);
  return res.text;
};

describe('анкеты полей: текст из формы', () => {
  it('анкеты есть только у существующих полей паспорта; текстовыми остаются поля, где важна формулировка', () => {
    const all = PASSPORT_SECTIONS.flatMap((s) => s.fields.map((f) => `${s.id}/${f}`));
    for (const key of Object.keys(FIELD_FORMS)) expect(all).toContain(key);
    for (const key of ['3/problem_description', '3/target_audience', '4/product_summary', '5/first_stage_result', '6/novelty_hypothesis', '6/verification_protocol']) {
      expect(FIELD_FORMS[key]).toBeUndefined();
    }
  });

  it('команда: таблица ФИО и ролей → «В команде N человек: …»', () => {
    expect(
      text('2/team_members', { rows: [{ name: 'Иван Иванов', role: 'разработка, backend' }, { name: 'Мария Петрова', role: 'продукт и интервью.' }, { name: '', role: '' }] }),
    ).toBe('В команде 2 человека: Иван Иванов (разработка, backend), Мария Петрова (продукт и интервью).');
    expect(text('2/team_members', { rows: [{ name: 'Иван', role: 'всё' }] })).toBe('В команде 1 человек: Иван (всё).');
  });

  it('опыт команды: строки берутся из анкеты команды', () => {
    expect(emptyForm(FIELD_FORMS['2/competencies_and_experience']!, ctx).rows).toEqual([
      { name: 'Иван Иванов', experience: '' },
      { name: 'Мария Петрова', experience: '' },
    ]);
    expect(text('2/competencies_and_experience', { rows: [{ name: 'Иван Иванов', experience: 'React, 2 проекта' }] })).toBe('Иван Иванов: React, 2 проекта.');
  });

  it('функции и технологии — списком', () => {
    expect(text('4/core_features', { rows: [{ feature: 'подбор по маршруту' }, { feature: 'чат' }] })).toBe('Ключевые функции:\n— подбор по маршруту\n— чат');
    expect(text('4/tech_approach', { rows: [{ part: 'Клиент', tech: 'React' }] })).toBe('Клиент: React.');
  });

  it('стадия: выбор и что работает; у идеи описание необязательно', () => {
    expect(text('5/current_stage', { choice: 'Прототип', text: 'работает поиск' })).toBe('Прототип: работает поиск.');
    expect(text('5/current_stage', { choice: 'Идея' })).toBe('Идея.');
    expect(save('5/current_stage', { choice: 'MVP' })).toEqual({ ok: false, error: 'Опишите, что уже сделано и работает.' });
  });

  it('MVP: функции со статусом', () => {
    expect(text('5/existing_backlog_and_mvp', { rows: [{ feature: 'регистрация', status: 'в разработке' }], text: 'версия 0.2' })).toBe(
      'Функции MVP:\n— регистрация — в разработке\nверсия 0.2',
    );
  });

  it('календарный план: месяцы в пределах этапа', () => {
    expect(text('5/calendar_plan_stage_1', { rows: [{ months: '1', work: 'интервью', result: 'отчёт' }, { months: '1-2', work: 'прототип', result: 'демо' }] })).toBe(
      'Месяц 1: интервью; результат — отчёт.\nМесяцы 1–2: прототип; результат — демо.',
    );
    expect(save('5/calendar_plan_stage_1', { rows: [{ months: '3', work: 'а', result: 'б' }] })).toEqual({
      ok: false,
      error: 'Строка 1, «Месяцы»: этап длится с 1-го по 2-й месяц.',
    });
    expect(text('5/calendar_plan_stage_2', { rows: [{ months: '3–12', work: 'пилот', result: '500 поездок' }] })).toBe('Месяцы 3–12: пилот; результат — 500 поездок.');
  });

  it('аналоги: не меньше двух', () => {
    expect(save('6/analogues_comparison', { rows: [{ name: 'А', how: 'б', diff: 'в' }] })).toEqual({ ok: false, error: 'Нужно строк: не меньше 2.' });
    expect(text('6/analogues_comparison', { rows: [{ name: 'BlaBlaCar', how: 'соцсети', diff: 'почта вуза' }, { name: 'Чаты ВК', how: 'без проверки', diff: 'проверка' }] })).toBe(
      'Аналог 1: BlaBlaCar — соцсети. Наше отличие: почта вуза.\nАналог 2: Чаты ВК — без проверки. Наше отличие: проверка.',
    );
  });

  it('рынок: без источника — оценка команды', () => {
    expect(text('7/market_overview', { inputs: { segment: 'студенты вузов', size: 'около 40 000' } })).toBe('студенты вузов — около 40 000 (оценка команды).');
    expect(text('7/market_overview', { inputs: { segment: 'студенты', size: '40 000', source: 'статистика вуза' } })).toBe('студенты — 40 000 по данным: статистика вуза.');
  });

  it('бизнес-модель: хотя бы одна отметка', () => {
    expect(save('7/business_model_and_pricing', { flags: [], text: 'подписка' })).toEqual({ ok: false, error: 'Отметьте хотя бы один вариант: «Кто платит».' });
    expect(text('7/business_model_and_pricing', { flags: ['B2B — компании'], text: 'подписка для вузов' })).toBe('Модель: B2B — компании.\nподписка для вузов');
  });

  it('пилоты: «пока нет» или факты и планы раздельно', () => {
    expect(text('7/traction_and_pilots', { choice: 'Пока нет', rows: [{ event: 'забытая строка' }] })).toBe('Пилотов, фокус-групп и продаж пока нет.');
    expect(
      text('7/traction_and_pilots', {
        choice: 'Есть или запланированы',
        rows: [
          { event: '2 фокус-группы', date: 'февраль 2026', kind: 'Сделано' },
          { event: 'пилот с вузом', date: '2027', kind: 'В планах' },
        ],
      }),
    ).toBe('Сделано:\n— 2 фокус-группы (февраль 2026)\nВ планах:\n— пилот с вузом (2027)');
  });

  it('юрлицо: «нет» без реквизитов; ООО — с проверкой ИНН и ОГРН', () => {
    expect(text('8/legal_entity_info', { choice: 'Нет, создадим ООО при победе' })).toBe('Юрлицо не создано; будет создано ООО при победе в конкурсе.');
    expect(save('8/legal_entity_info', { choice: 'ООО', inputs: { name: 'ООО «Попутчик»', inn: '123', ogrn: '1234567890123' } })).toEqual({
      ok: false,
      error: '«ИНН»: 10 или 12 цифр.',
    });
    expect(text('8/legal_entity_info', { choice: 'ООО', inputs: { name: 'ООО «Попутчик»', inn: '1234567890', ogrn: '1234567890123' } })).toBe(
      'ООО «Попутчик», ИНН 1234567890, ОГРН 1234567890123.',
    );
    expect(text('8/legal_entity_info', { choice: 'ИП', inputs: { name: 'Иванов И. И.', inn: '123456789012', ogrn: '123456789012345' } })).toBe(
      'ИП Иванов И. И., ИНН 123456789012, ОГРНИП 123456789012345.',
    );
  });

  it('роли организаций', () => {
    expect(text('8/entity_roles', { rows: [{ who: 'Иван Иванов', role: 'заявитель' }] })).toBe('Иван Иванов — заявитель.');
    expect(save('8/entity_roles', { rows: [{ who: 'Иван', role: 'директор' }] })).toEqual({ ok: false, error: 'Строка 1: выберите «Роль» из списка.' });
  });

  it('авторы: из команды и другие; хотя бы один', () => {
    expect(save('9/ip_rights_and_authors', { flags: [], inputs: { owner: 'авторы' } })).toEqual({ ok: false, error: 'Укажите хотя бы одного автора.' });
    expect(text('9/ip_rights_and_authors', { flags: ['Иван Иванов'], inputs: { others: 'Олег Сидоров', owner: 'авторы до регистрации ООО' } })).toBe(
      'Авторы — Иван Иванов, Олег Сидоров. Правообладатель: авторы до регистрации ООО.',
    );
  });

  it('РИД: «нет» с отметкой плана или таблица свидетельств', () => {
    expect(text('9/rid_certificates', { choice: 'Нет', flags: ['Планируем подать заявку'] })).toBe('Свидетельств РИД нет; подача заявки запланирована.');
    expect(text('9/rid_certificates', { choice: 'Нет' })).toBe('Свидетельств РИД нет.');
    expect(text('9/rid_certificates', { choice: 'Есть', rows: [{ type: 'Программа для ЭВМ', number: '2026612345', date: '12.03.2026' }] })).toBe(
      'Программа для ЭВМ: свидетельство № 2026612345 от 12.03.2026.',
    );
  });

  it('гранты и обязательства: «да/нет»', () => {
    expect(text('10/previous_grants_and_statuses', { choice: 'Не получали' })).toBe('Ранее грантов, статусов и другой поддержки не получали.');
    expect(text('10/previous_grants_and_statuses', { choice: 'Получали', rows: [{ kind: 'Грант ФСИ', name: 'УМНИК', year: '2025' }] })).toBe('Грант ФСИ («УМНИК»), 2025.');
    expect(save('10/previous_grants_and_statuses', { choice: 'Получали', rows: [{ kind: 'Грант ФСИ', year: '25' }] })).toEqual({
      ok: false,
      error: 'Строка 1, «Год»: год — четыре цифры, например 2025.',
    });
    expect(text('10/active_obligations', { choice: 'Нет' })).toBe('Открытых договоров и обязательств нет.');
    expect(save('10/active_obligations', { choice: 'Есть', text: '' })).toEqual({ ok: false, error: 'Заполните поле «Какие обязательства».' });
  });

  it('без выбора варианта не сохраняется', () => {
    expect(validateForm(FIELD_FORMS['10/active_obligations']!, {}, ctx)).toBe('Выберите вариант: «Открытые договоры и обязательства».');
  });

  it('сохраняются только показанные части: строки скрытой таблицы в форму не попадают', () => {
    const res = save('9/rid_certificates', { choice: 'Нет', rows: [{ type: 'База данных', number: '1', date: '1' }] });
    expect(res.ok && res.data.rows).toEqual([]);
  });

  it('форма из сохранённых данных: чужой вариант выбора не принимаем; имена команды', () => {
    expect(formFromData(FIELD_FORMS['10/active_obligations']!, { choice: 'Может быть' })).toBeNull();
    expect(formFromData(FIELD_FORMS['10/active_obligations']!, { choice: 'Нет' })?.choice).toBe('Нет');
    expect(teamFromData({ rows: [{ name: ' Иван ' }, { name: '' }, {}] })).toEqual(['Иван']);
    expect(teamFromData(undefined)).toEqual([]);
  });
});
