const db = require('./db');

const MetaAula = db.sequelize.define('tb_metas_aulas', {
    title: {
        type: db.Sequelize.STRING(50),
        allowNull: false
    },
    description: {
        type: db.Sequelize.TEXT,
        allowNull: false
    },
    start_date: {
        type: db.Sequelize.DATEONLY,
        allowNull: false
    },
    end_date: {
        type: db.Sequelize.DATEONLY,
        allowNull: false
    },
    created_by: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    status: {
        type: db.Sequelize.ENUM('A', 'E'),
        allowNull: false,
        defaultValue: 'A'
    }
});

MetaAula.associate = (models) => {
    if (!models || !models.Usuario || !models.Turma || !models.MetaAulaTurma) {
        return;
    }

    MetaAula.belongsTo(models.Usuario, {
        as: 'criador',
        foreignKey: 'created_by',
        targetKey: 'user_code'
    });

    MetaAula.belongsToMany(models.Turma, {
        through: models.MetaAulaTurma,
        foreignKey: 'meta_id',
        otherKey: 'class_code',
        as: 'turmas'
    });
};

MetaAula.sync({ alter: true });

module.exports = MetaAula;
