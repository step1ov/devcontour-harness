// Поток сдачи тонкого режима (alpha.73): дерево работы, слияние с целью,
// gates на чистом checkout, одно ревью, CAS. Реализация — шаг S5; до неё
// попытка тонкого режима отказывает явно, а не идёт путём облегчённого.

import { TaskFailure } from '../contracts/index.ts';
import type { ThinHandover, ThinKit } from './kit.ts';

export const thinFlow = {
  handover(_kit: ThinKit, input: ThinHandover): Promise<string> {
    return Promise.reject(
      new TaskFailure(
        'needs-lead',
        `Работа ${input.work.id}: поток сдачи тонкого режима (harnessMode: thin) ещё не реализован в этой версии harness; выберите harnessMode: light`,
      ),
    );
  },
};
