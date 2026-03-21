const db = require('./db');

// tb_usuarios
const Usuario = db.sequelize.define('tb_usuarios', {
    first_name: db.Sequelize.STRING,
    last_name: db.Sequelize.STRING,
    email: { 
        type: db.Sequelize.STRING, 
        unique: true,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    password: { 
        type: db.Sequelize.STRING, 
        allowNull: false,
        validate: {
            len:[8,32]            
        }
    },
    role: {
        type: db.Sequelize.ENUM('ADM', 'PRO', 'STD'),
        allowNull: false,
        defaultValue: 'STD',
        validate: {
            isIn: [['ADM', 'PRO', 'STD']]
        }
    },
    phone: {
        type: db.Sequelize.CHAR(11),
        allowNull: true,
        validate: {
            is: /^[0-9]{11}$/
        }
    },
    birth_date: {
        type: db.Sequelize.DATEONLY,
        allowNull: false,
        validate: {
            isDate: true,
            isBefore: new Date().toISOString().split('T')[0]
        }
    },
    actual_belt: {
        type: db.Sequelize.ENUM(
            'white', 
            'gray-white', 'gray', 'gray-black', 
            'yellow-white', 'yellow', 'yellow-black', 
            'orange-white', 'orange', 'orange-black', 
            'green-white', 'green', 'green-black', 
            'blue', 'purple', 'brown', 'black'),
        allowNull: false,
        defaultValue: 'white',
        validate: {
            isIn: [['white', 'gray-white', 'gray', 'gray-black', 'yellow-white', 'yellow', 'yellow-black', 'orange-white', 'orange', 'orange-black', 'green-white', 'green', 'green-black', 'blue', 'purple', 'brown', 'black']]
        }
    },
    actual_degree: {
        type: db.Sequelize.ENUM('0', '1', '2', '3', '4', '5', '6'),
        allowNull: false,
        defaultValue: '0',
        validate: {
            isIn: [['0', '1', '2', '3', '4', '5', '6']]
        }
    },
    wagi_size: {
        type: db.Sequelize.CHAR(3),
        allowNull: false,
    },
    zubon_size: {
        type: db.Sequelize.CHAR(3),
        allowNull: false,
    },
    obi_size: {
        type: db.Sequelize.CHAR(2),
        allowNull: false,
    },
    photo :{
        type: db.Sequelize.STRING,
        allowNull: true,
        validate: {
            is: /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i,
            len: [1, 255],
        },
        defaultValue: '/uploads/users/default.jpg',
    },
    responsible_id: {
        type: db.Sequelize.INTEGER,
        allowNull: true,
    },
    active : {
        type: db.Sequelize.BOOLEAN, 
        defaultValue: true,
    }
});

// Usuario.sync({ alter: true });

module.exports = Usuario;
