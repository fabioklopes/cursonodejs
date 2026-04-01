const db = require('./db');

// tb_mensagens_professores_ocultacoes
const MensagemProfessorOcultacao = db.sequelize.define('tb_mensagens_professores_ocultacoes', {
    message_id: {
        type: db.Sequelize.INTEGER,
        allowNull: false
    },
    user_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    hidden_at: {
        type: db.Sequelize.DATE,
        allowNull: false,
        defaultValue: db.Sequelize.NOW
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['message_id', 'user_code']
        }
    ]
});

MensagemProfessorOcultacao.associate = (models) => {
    if (!models || !models.MensagemProfessor || !models.Usuario) {
        return;
    }

    MensagemProfessorOcultacao.belongsTo(models.MensagemProfessor, {
        as: 'mensagem',
        foreignKey: 'message_id',
        targetKey: 'id'
    });

    MensagemProfessorOcultacao.belongsTo(models.Usuario, {
        as: 'aluno',
        foreignKey: 'user_code',
        targetKey: 'user_code'
    });
};

module.exports = MensagemProfessorOcultacao;
