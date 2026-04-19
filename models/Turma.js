const db = require('./db');

// tb_turmas
const Turma = db.sequelize.define('tb_turmas', {
    class_name: {
        type: db.Sequelize.STRING(100),
        allowNull: false, 
        unique: true
    },
    class_code: {
        type: db.Sequelize.STRING(5),
        allowNull: false,
        primaryKey: true
    },
    created_by: {
        type: db.Sequelize.STRING(5),
        allowNull: false
    },
    active: {
        type: db.Sequelize.ENUM('Y', 'N'),
        allowNull: false,
        defaultValue: 'Y'
    }
}, {
    timestamps: true
});

Turma.associate = (models) => {
    if (!models || !models.Usuario) {
        return;
    }

    Turma.belongsTo(models.Usuario, {
        as: 'criador',
        foreignKey: 'created_by',
        targetKey: 'user_code'
    });
};

module.exports = Turma;