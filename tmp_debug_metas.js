const { sequelize } = require('./models/db');
const Usuario = require('./models/Usuario');
const TurmaAluno = require('./models/TurmaAluno');
const MetaAula = require('./models/MetaAula');
const Turma = require('./models/Turma');
const UsuarioModel = require('./models/Usuario');
const { Op } = require('sequelize');

(async () => {
  try {
    await sequelize.authenticate();
    const aluno = await Usuario.findOne({ where: { role: 'STD' } });
    console.log('Aluno:', aluno ? aluno.user_code : 'nenhum');
    if (!aluno) return;
    const turmas = await TurmaAluno.findAll({ where: { user_code: aluno.user_code, active: 'Y' }, attributes: ['class_code'] });
    console.log('Turmas:', turmas.map(t => t.class_code));
    const today = new Date();
    today.setHours(0,0,0,0);
    const metas = await MetaAula.findAndCountAll({
      where: {
        status: 'A',
        end_date: { [Op.gte]: today }
      },
      include: [
        { model: Turma, as: 'turmas', through: { attributes: [] }, where: { class_code: { [Op.in]: turmas.map(t => t.class_code) } } },
        { model: UsuarioModel, as: 'criador', attributes: ['first_name', 'last_name'] }
      ],
      order: [['start_date', 'ASC']],
      limit: 10,
      offset: 0,
      distinct: true,
      raw: false
    });
    console.log('Count:', metas.count);
    console.log('Rows:', metas.rows.length);
    if (metas.rows.length > 0) {
      console.log('First row', metas.rows[0].dataValues);
    }
  } catch (e) {
    console.error('Erro:', e);
  } finally {
    await sequelize.close();
  }
})();