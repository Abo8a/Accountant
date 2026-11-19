import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FieldEditor } from './FieldEditor';
import { FIELD_FORMS } from './schemas';

const ctx = { team: [] as string[] };

function renderEditor(key: string, props: Partial<Parameters<typeof FieldEditor>[0]> = {}) {
  const onSave = vi.fn();
  render(<FieldEditor inputId="f" initialText="" wasApproved={false} busy={false} spec={FIELD_FORMS[key]} ctx={ctx} onSave={onSave} onCancel={() => undefined} {...props} />);
  return onSave;
}

describe('FieldEditor — интерактивная анкета', () => {
  it('команда: заполнить строку, «+ Добавить участника», сохранить — уходит текст и форма', async () => {
    const user = userEvent.setup();
    const onSave = renderEditor('2/team_members');
    await user.type(screen.getByRole('textbox', { name: 'ФИО, строка 1' }), 'Иван Иванов');
    await user.type(screen.getByRole('textbox', { name: 'Роль в проекте, строка 1' }), 'разработка');
    await user.click(screen.getByRole('button', { name: '+ Добавить участника' }));
    await user.type(screen.getByRole('textbox', { name: 'ФИО, строка 2' }), 'Мария Петрова');
    await user.type(screen.getByRole('textbox', { name: 'Роль в проекте, строка 2' }), 'дизайн');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSave).toHaveBeenCalledWith('В команде 2 человека: Иван Иванов (разработка), Мария Петрова (дизайн).', {
      choice: '',
      flags: [],
      inputs: {},
      rows: [
        { name: 'Иван Иванов', role: 'разработка' },
        { name: 'Мария Петрова', role: 'дизайн' },
      ],
      text: '',
    });
  });

  it('строку можно удалить; последнюю — нельзя', async () => {
    const user = userEvent.setup();
    renderEditor('2/team_members');
    expect(screen.getByRole('button', { name: 'Удалить строку 1' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '+ Добавить участника' }));
    await user.click(screen.getByRole('button', { name: 'Удалить строку 2' }));
    expect(screen.queryByRole('textbox', { name: 'ФИО, строка 2' })).not.toBeInTheDocument();
  });

  it('незаполненная форма не сохраняется, ошибка объясняет, что исправить', async () => {
    const user = userEvent.setup();
    const onSave = renderEditor('6/analogues_comparison');
    await user.type(screen.getByRole('textbox', { name: 'Аналог, строка 1' }), 'BlaBlaCar');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Нужно строк: не меньше 2.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('«да/нет»: выбор «Есть» открывает таблицу, «Нет» — отметку плана', async () => {
    const user = userEvent.setup();
    const onSave = renderEditor('9/rid_certificates');
    await user.click(screen.getByRole('radio', { name: 'Есть' }));
    expect(screen.getByRole('combobox', { name: 'Что зарегистрировано, строка 1' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Нет' }));
    expect(screen.queryByRole('combobox', { name: 'Что зарегистрировано, строка 1' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Планируем подать заявку' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSave).toHaveBeenCalledWith('Свидетельств РИД нет; подача заявки запланирована.', expect.objectContaining({ choice: 'Нет', flags: ['Планируем подать заявку'] }));
  });

  it('текст, написанный словами, правится текстом; «Заполнить формой» открывает анкету', async () => {
    const user = userEvent.setup();
    const onSave = renderEditor('10/active_obligations', { initialText: 'Открытых договоров нет.' });
    expect(screen.getByRole('textbox')).toHaveValue('Открытых договоров нет.');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(onSave).toHaveBeenCalledWith('Открытых договоров нет.');
    await user.click(screen.getByRole('button', { name: 'Заполнить формой' }));
    expect(screen.getByRole('radio', { name: 'Нет' })).toBeInTheDocument();
  });

  it('сохранённая форма открывается как была, даже если ИИ переписал текст', () => {
    renderEditor('2/team_members', { initialText: 'Команда из двух человек…', formData: { rows: [{ name: 'Иван', role: 'код' }] } });
    expect(screen.getByRole('textbox', { name: 'ФИО, строка 1' })).toHaveValue('Иван');
  });

  it('«Написать текстом» переносит собранный текст в поле', async () => {
    const user = userEvent.setup();
    renderEditor('10/active_obligations');
    await user.click(screen.getByRole('radio', { name: 'Нет' }));
    await user.click(screen.getByRole('button', { name: 'Написать текстом' }));
    expect(screen.getByRole('textbox')).toHaveValue('Открытых договоров и обязательств нет.');
  });

  it('опыт команды: участники подставляются из анкеты команды', () => {
    function Wrapper() {
      const [team] = useState(['Иван Иванов']);
      return <FieldEditor inputId="f" initialText="" wasApproved={false} busy={false} spec={FIELD_FORMS['2/competencies_and_experience']} ctx={{ team }} onSave={() => undefined} onCancel={() => undefined} />;
    }
    render(<Wrapper />);
    expect(screen.getByRole('textbox', { name: 'Участник, строка 1' })).toHaveValue('Иван Иванов');
  });

  it('поле без анкеты — обычный текст', () => {
    render(<FieldEditor inputId="f" initialText="" wasApproved={false} busy={false} ctx={ctx} onSave={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Заполнить формой' })).not.toBeInTheDocument();
  });
});
