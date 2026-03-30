const db = require('./db');

// tb_turma_alunos
const TurmaAluno = db.sequelize.define('tb_turma_alunos', {
    class_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    user_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    active: {
        type: db.Sequelize.ENUM('Y', 'N'),
        allowNull: false,
        defaultValue: 'Y'
    },
    enrolled_by: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    }
}, {
    indexes: [
        {
            unique: true,
            fields: ['class_code', 'user_code']
        }
    ]
});

TurmaAluno.associate = (models) => {
    if (!models || !models.Usuario || !models.Turma) {
        return;
    }

    TurmaAluno.belongsTo(models.Usuario, {
        as: 'aluno',
        foreignKey: 'user_code',
        targetKey: 'user_code'
    });

    TurmaAluno.belongsTo(models.Turma, {
        as: 'turma',
        foreignKey: 'class_code',
        targetKey: 'class_code'
    });
};

module.exports = TurmaAluno;
