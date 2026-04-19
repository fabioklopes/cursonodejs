const db = require('./db');

// tb_mensagens_professores_leituras
const MensagemProfessorLeitura = db.sequelize.define('tb_mensagens_professores_leituras', {
    message_id: {
        type: db.Sequelize.INTEGER,
        allowNull: false
    },
    user_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    viewed_at: {
        type: db.Sequelize.DATE,
        allowNull: true,
        defaultValue: null
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['message_id', 'user_code']
        }
    ]
});

MensagemProfessorLeitura.associate = (models) => {
    if (!models || !models.MensagemProfessor || !models.Usuario) {
        return;
    }

    MensagemProfessorLeitura.belongsTo(models.MensagemProfessor, {
        as: 'mensagem',
        foreignKey: 'message_id',
        targetKey: 'id'
    });

    MensagemProfessorLeitura.belongsTo(models.Usuario, {
        as: 'aluno',
        foreignKey: 'user_code',
        targetKey: 'user_code'
    });
};

module.exports = MensagemProfessorLeitura;