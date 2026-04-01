const db = require('./db');


// tb_mensagens_professores
const MensagemProfessor = db.sequelize.define('tb_mensagens_professores', {
    title: db.Sequelize.STRING(25),
    content: db.Sequelize.STRING(255),
    class: db.Sequelize.STRING(5),
    created_by: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    expires_at: db.Sequelize.DATE,
    status: {
        type: db.Sequelize.ENUM('A', 'E'),
        defaultValue: 'A',
    }
});

MensagemProfessor.associate = (models) => {
    MensagemProfessor.belongsTo(models.Turma,{
        as: 'turma',
        foreignKey: 'class',
        targetKey: 'class_code'
    });

    MensagemProfessor.belongsTo(models.Usuario, {
        as: 'criador',
        foreignKey: 'created_by',
        targetKey: 'user_code'
    });
};

/** 
 * Nota: Use com cuidado em produção, pois pode resultar em perda de dados.
 * Opções válidas:
 * - force: true - Apaga a tabela existente e cria uma nova (perda de dados).
 * - alter: true - Altera a tabela para corresponder ao modelo, sem apagar dados (recomendado para produção).
*/
// MensagemProfessor.sync({ force: true });

module.exports = MensagemProfessor;